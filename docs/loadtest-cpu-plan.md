# Plan: lägre CPU och ett lasttest som speglar verkligheten

Gren: `loadtest`. Mål: `normal-sale` och `spike-sale` klaras på de två ordinarie noderna (cpx22) utan
att CPU:n tar slut, med booking-api som kan skala via HPA, och med ett test som går samma väg som
riktiga användare (genom Cloudflare).

## Varför CPU:n tar slut idag

1. **Kön pollas.** Varje köande frågar `GET /queue/status` varannan sekund, både webbappen
   (`use-queue-admission.ts`) och k6 (`tests/load/lib/booking-flow.js`). Med upp till 45 000 köande
   i spike-sale blir det cirka 22 000 anrop per sekund som bara svarar "inte än".
2. **Tracing utan mottagare.** OpenTelemetry spårar 100 % av alla anrop i alla tjänster (HTTP, pg,
   Redis, RabbitMQ, net, dns) och skickar allt till Alloy, som slänger det (Tempo är inte utrullat).
3. **Två loggrader per anrop.** Fastify loggar varje request. Alloy och Loki måste läsa och lagra dem.
4. **Stolsstatus byggs om varje gång.** Svaret (cirka 96 KB per sektion) läses ur Redis, tolkas och
   serialiseras om för varje anrop.
5. **Testet går förbi Cloudflare.** k6 går mot `loadtest.tikknet.se` direkt, så det som Cloudflare
   cachar för riktiga användare (stolsstatus 1 s, arenageometri 30 dagar) träffar klustret varje gång.
6. **Reservationer av CPU.** Varje podd reserverar CPU (`requests`), och det som redan körs reserverar
   cirka 3 av 4 kärnor. booking-api får då inte plats att skala, oavsett faktisk användning.
7. **ingress-nginx loggar varje anrop** (access-loggen är på som standard). Det är ännu en rad per
   request som Alloy och Loki måste hantera, utöver appens egna.
8. **RabbitMQ snurrar på CPU:n.** Erlang låter sina schemaläggare "busy-wait" (vänta aktivt) som
   standard. På små, delade noder bränner det CPU även när kön är nästan tom, och RabbitMQ får upp till
   1,5 kärnor (`limits`).
9. **Sektionssammanfattningen räknas om i Postgres varje gång.** Platskartan hämtar
   `GET /events/:id/sections/summary` var 10:e sekund per besökare. Varje anrop gör en `GROUP BY` över
   alla eventets stolar, och svaret cachas varken i Redis eller i Cloudflare.
10. **TLS-handskakningar.** Direkt mot klustret måste ingress-nginx göra en TLS-handskakning för varje
    ny anslutning från k6. Genom Cloudflare avslutas TLS hos Cloudflare, som återanvänder ett fåtal
    anslutningar mot klustret (åtgärdas av steg 6).

Okänt tills det är mätt: Prometheus, Grafana, Loki och Alloy själva, k3s egna processer (API-server,
CoreDNS, metrics-server) och KEDA. Steg 0 visar om något av dem är stort.

PostHog tas inte bort: webbläsarens analys går direkt till PostHog via Cloudflare, och serversidans
händelser är få och stängs redan av i `loadtest-mode`.

## Mätning i vila (4/11)

| Nod | Faktisk CPU | Reserverat (`requests`) |
|---|---|---|
| tickets-cp-1 | 399m (19 %) | 1535m (76 %) |
| tickets-worker-1 | 199m (9 %) | 1510m (75 %) |

Noderna används knappt, men tre fjärdedelar är reserverade. Kvar är cirka 0,5 kärna per nod, alltså
plats för ungefär tre booking-api-poddar till (250m var) innan resten blir `Pending`. RabbitMQ är
överst i vila (48m). Förbrukningen under last mäts i steg 0.

## Principer

- **Bara poddar skalar, aldrig noder.** Lasttestet ska klaras på de två ordinarie noderna (cpx22).
  Inga demo-noder (`demo_node_count` stannar på 0) och ingen nodautoskalning. Nodernas storlek är
  taket, och HPA skalar poddarna inom det.
- **Observability finns kvar.** Prometheus och Grafana (mått) och Loki och Alloy (loggar) behålls.
  Bara tracing (OpenTelemetry och Tempo) tas bort. Vi loggar sparsammare och behåller de grafer som
  faktiskt behövs, men inget tas bort helt.

- Ett steg i taget, var och ett med egna tester, och inget steg ändrar affärslogiken (köregler,
  reservationer, betalning, idempotens).
- API-kontrakten (Pact) är oförändrade, utom där steg 3 lägger till att webbappen lyssnar på
  WebSocket-meddelanden som servern redan skickar.
- Varje steg mäts: samma korta körning före och efter, så att vi vet vad som faktiskt hjälpte.
- Allt körs lokalt (enhet, integration, kontrakt, e2e) innan något mergas.

## Steg 0: mät nuläget

Kör `smoke.js` och en kort `normal-sale` (2 minuter) och spara:

```sh
kubectl top nodes
kubectl top pods -A --sort-by=cpu | head -25
kubectl describe nodes | grep -A10 "Allocated resources"
kubectl get pods -n ticketing | grep Pending
```

Plus Grafana-panelerna "Nod-CPU-utnyttjande" och "CPU per booking-api-podd". Det är jämförelsen för
alla följande steg.

## Steg 1: ta bort tracing och Tempo helt

| Var | Ändring |
|---|---|
| `shared/observability/src/tracing.ts` | Tas bort, liksom exporten i paketets index |
| `services/*/src/instrumentation.ts` (5 st) | Tas bort |
| `services/*/Dockerfile`, `services/*/package.json` (start-skript), `.github/workflows/e2e.yml` | `--import …/instrumentation.js` tas bort |
| `services/*/package.json`, `shared/observability/package.json`, `tsup.base.ts` | `@opentelemetry/*`-beroendena och deras rader i `EXTERNAL_NPM_PACKAGES` tas bort, `pnpm-lock.yaml` uppdateras |
| `infra/k8s/base/*/deployment.yaml` (5 st) | `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` tas bort |
| `infra/terraform/observability.tf`, `variables.tf` | `helm_release.tempo`, `tempo_enabled`, `tempo_sampling_percentage` och Tempo-datakällan och dess länkar i Grafana tas bort |
| `infra/terraform/alloy-config.alloy.tftpl` | OTLP-mottagaren och trace-delen tas bort. Bara loggar till Loki är kvar |
| `infra/k8s/base/monitoring/prometheusrule.yaml` | Larmet `TempoVolumeFilling` tas bort |
| Dokument och ritningar | Tempo tas bort ur `plan.md`, `forsvar.md`, `architecture.md`, `runbook.md`, `phase-status.md`, `observability.svg` och `cluster.svg`. Svaret i försvaret blir "mått och loggar, inga traces". |

Pino-loggarnas `trace_id` försvinner. Inget annat läser den. Prometheus, Grafana, Loki och Alloy
(loggdelen) är kvar och oförändrade.

**Utrullning:** koden via vanlig merge. Terraform-delen för hand: `plan` och `apply` för
`helm_release.alloy` och `helm_release.kube_prometheus_stack` (Tempo-releasen finns aldrig i
produktion och behöver inte tas bort där). Planen granskas innan apply.

**Klart när:** alla tester gröna, Alloy skickar fortfarande loggar till Loki (Explore visar rader),
och tjänsternas CPU vid samma last är lägre än i steg 0.

## Steg 2: logga bara fel och långsamma anrop

- `disableRequestLogging: true` i booking-api (och realtime-gateway och payment-mock om de loggar
  per anrop).
- En `onResponse`-hook loggar anrop som tar mer än 1 s (metod, route, status, tid, request-id), och
  5xx loggas som idag av felhanteraren.
- Antalet anrop och felkvoten syns fortfarande i Prometheus (RED-panelerna och ingress-måtten).

- ingress-nginx: stäng av access-loggen (`disable-access-log = "true"` i Helm-värdena i
  `infra/terraform/helm.tf`). Antal anrop, status och svarstider finns kvar i ingress-måtten i
  Prometheus, som zero downtime-panelerna redan använder.

**Klart när:** enhetstest för hooken (långsamt anrop loggas, snabbt gör det inte), Loki visar fel och
långsamma anrop men inte vanliga, och ingress-panelerna i Grafana visar fortfarande data.

## Steg 3: insläpp ur kön via WebSocket, polling bara som reserv

Servern skickar redan `admitted`, `sales_closed` och `sold_out` till `ws:<kötoken>`. Det som saknas
är att klienterna lyssnar.

**Webbappen** (`apps/web/src/hooks/use-queue-admission.ts`):
- Kösidan ansluter med `useQueueSocket` (samma som platskartan) när den har ett kötoken.
- När ett av de tre meddelandena kommer hämtas status direkt (`refetch`), så att sidan aldrig litar
  på WebSocket ensam.
- Pollingen när man väntar går från 2 s till 15 s, som reserv om socketen inte kommer upp eller ett
  meddelande missas. När man är insläppt gäller samma minutintervall som idag.
- Tester: enhetstest för hooken (meddelande leder till ny status, och reservintervallet), Pact för de
  WebSocket-meddelanden webbappen nu tar emot, och e2e-specen `queue-direct-admit` oförändrad grön.

**k6** (`tests/load/lib/booking-flow.js`):
- `normal-sale` och `spike-sale` väntar med `waitForAdmissionViaWebSocket` (finns redan och används
  av `queue-storm`), med samma reservpolling på 15 s som webbappen.

**Risk:** många samtidiga WebSocket-anslutningar mot realtime-gateway (2–4 poddar, skalar på minne).
Det testas separat med `queue-storm` i steg 7 innan de stora körningarna.

## Steg 4: skicka stolsstatus som färdig sträng

- `services/booking-api/src/services/seatmap-service.ts`: Redis-cachen sparar det färdiga
  JSON-svaret, och controllern skickar strängen direkt med rätt `content-type`, utan att tolka och
  serialisera om.
- Samma format som idag. Inga ändringar i webbappen eller kontrakten.
- Tester: integrationstestet `events-seatmap` visar samma svar med och utan cache, plus ett test att
  ett cachat svar skickas oförändrat.
- Sektionssammanfattningen cachas på samma sätt i Redis i 5 s (samma tid som dess `max-age`), så att
  `GROUP BY`-frågan körs högst en gång per event och 5 sekunder i stället för en gång per besökare.

## Steg 5: CPU-reservationerna

Efter steg 1–4, med siffrorna från en ny mätning:
- `realtime-gateway`: sänk `requests.cpu` från 250m till 100m (den är minnesbunden och skalar på
  minne).
- Kontrollera att övervakningen (Prometheus, Loki, Alloy, Grafana) har rimliga `requests` och `limits`,
  så att den aldrig kan svälta appen under ett test.
- RabbitMQ: stäng av Erlangs busy-wait med
  `RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS="+sbwt none +sbwtdcpu none +sbwtdio none"` i StatefulSet:en
  (RabbitMQ:s egen rekommendation för delade CPU:er), och sänk `limits.cpu` från 1500m.
- Målet är att det finns reserverbart utrymme för minst 6 booking-api-poddar (6 × 250m) på de två
  noderna.
- Räkningen: varje nod har cirka 2000m. Idag är cirka 465m (cp-1) och 490m (worker-1) lediga, vilket
  räcker till en booking-api-podd till per nod: **4 totalt idag**. Efter steg 5 (realtime-gateway
  +300m, payment-mocks 4 lasttestrepliker −150m) blir det cirka 550m per nod, två poddar till per nod:
  **6 totalt**. Kontrolleras med `kubectl describe nodes` efter ändringen.
- booking-apis HPA-tak (`maxReplicas`, idag 10) sätts till **6**, det antal som faktiskt ryms efter
  ändringarna. Annars blir de extra poddarna `Pending` och ser ut som ett fel. Taket och skälet
  dokumenteras i `hpa.yaml`.

## Steg 5b: färre men viktigare grafer

Panelerna i `infra/k8s/base/monitoring/dashboards.yaml` gås igenom. Varje panel som blir kvar ska svara
på en fråga vi faktiskt ställer vid drift, försvar eller lasttest. Dubbletter och utfyllnad tas bort.
Alla fyra dashboards finns kvar.

| Dashboard | Behålls | Tas bort eller slås ihop |
|---|---|---|
| RED overview | Anrop per tjänst, felkvot (5xx), p95-svarstid | p99 (dubblett av p95 för vår användning) |
| Infrastruktur per shard | Postgres uppe, Postgres-anslutningar, RabbitMQ-ködjup, döda meddelanden | Redis-klienter |
| Business | `oversell_prevented_total`, sålda mot 5 000-taket, ködjup, insläppstakt, aktiva reservationer | Konverteringsgrad |
| Autoscaling och lasttest | Repliker över tid, HPA booking-api, CPU per booking-api-podd, nod-CPU, zero downtime (5xx/s, ready-repliker, request rate) | HPA realtime-gateway, minne per realtime-gateway-podd, nod-minne, podd-omstarter, demopanelen (dubblett av repliker plus CPU), deploymarkörer |

Deploymarkörerna (de lodräta strecken vid en utrullning) behålls: de är ingen panel och hör till
förklaringen av zero downtime. Larmen i `prometheusrule.yaml` behålls (utom Tempo-larmet, steg 1), eftersom de är billiga och är det som
skickas till Slack. Den slutliga listan stäms av innan den ändras. Grafer kostar bara när de visas, så
det här är för tydlighetens skull, inte för CPU:n.

## Steg 6: lasttestet går genom Cloudflare

- `tests/load/lib/config.js`: `BASE_URL` blir `https://api.tikknet.se` och `WS_BASE_URL`
  `wss://api.tikknet.se`, alltså samma väg som webbappen.
- `infra/terraform`: en Cloudflare-regel (`cloudflare_ruleset`, fasen
  `http_request_firewall_custom`) som undantar loadgen-IP:erna från WAF- och säkerhetskontrollerna.
  Den skapas bara när `loadgen_node_count > 0`, så den finns aldrig i vardagen.
- Kontrollera i Cloudflare att **Bot Fight Mode** är avstängt under testet. På gratisplanen kan det
  inte undantas med en regel.
- booking-apis rate limiter läser `CF-Connecting-IP`, som blir loadgen-IP:n och redan är undantagen i
  `loadtest-mode`. `scripts/loadtest-mode.sh` och runbooken uppdateras med det nya flödet.
- `loadtest.tikknet.se` behålls för `deploy-under-load` och felsökning direkt mot klustret.
- k6 gör det riktiga användare gör på kartan: under tiden de "väljer stolar" hämtar de stolsstatus
  varannan sekund och sammanfattningen var 10:e sekund, som webbappen. Idag hämtar k6 bara
  stolsstatusen en gång, så testet underskattar den delen. Genom Cloudflare cachas stolsstatusen,
  men sammanfattningen inte (därför steg 4).
- Dokumentera i rapporten vad som cachas av Cloudflare (stolsstatus 1 s, arenageometri 30 dagar) och
  vad som inte gör det (kö, reservation, checkout), så att resultatet går att tolka.

**Risk:** Cloudflare kan ändå strypa eller utmana trafiken från två IP-adresser. Då syns det som
403/429 eller `cf-mitigated` i k6, och vi justerar regeln innan resultaten räknas.

## Steg 7: kör om och spara beviset

I ordning, med `loadtest-mode on` och minst en loadgen-VM:
1. `smoke.js`
2. `queue-storm.js` (WebSocket under last)
3. `normal-sale.js`
4. `spike-sale.js`

Spara för varje körning k6-sammanfattningen, `generate-sale-report` (före `reset-sale`) och
Grafana-skärmdumpar i `docs/evidence/load-tests.md`, på samma sätt som `zero-downtime.md`.

## Godkänt när

- 0 dubbelsålda platser och inga dubbla biljettnummer (rapporten).
- Inga 5xx i ingress och `http_req_failed` under tröskeln i k6.
- Nodernas CPU under cirka 80 % under toppen.
- booking-api skalar upp med HPA utan poddar i `Pending`, och ner igen efteråt.
- Alla tester gröna och granskade innan merge.

## Ordning och utrullning

Steg 1, 2 och 4 är oberoende och låg risk, och kan mergas först. Steg 3 ändrar webbappen och går som
en egen PR. Steg 5 och 6 kräver Terraform och görs för hand efter att koden är ute. Steg 7 sist.
Varje Terraform-ändring körs som `plan` först, och planen granskas innan `apply`.

## Status (byggt på grenen `loadtest`)

Steg 1–6 är byggda och testade. Steg 0 och 7 (mätning och körning i produktion) görs av dig.
Avvikelser och tillägg efter granskningen:

- **Loggningen** använder en egen `LogController` (`QuietRequestLogController` i
  `shared/observability`), inte `disableRequestLogging`. Den senare tystade även 5xx-felloggningen och
  är utfasad i Fastify 5. Paketet har därför Fastify som peer-beroende (samma version som tjänsterna).
- **Kösidan** pollar var 15:e sekund bara när socketen är uppe. Utan socket (ingen gateway, under
  återanslutning) pollar den varannan sekund som förut, och varje (åter)anslutning läser status direkt.
- **k6** behandlar tillfälliga fel som "väntar" och pollar varannan sekund om socketen stängs i förtid.
- **Sammanfattningscachen** i Redis följer API-cachens av-knapp (`summaryCacheSeconds`, 0 = av).
- **notification-worker** får taket 4 (var 10), och larmet `RabbitMQQueueDepthHigh` går vid 360.
  CPU-budgeten delas: skalar realtime-gateway (till 4) och notification-worker (till 4) samtidigt
  ryms 5 booking-api-poddar, annars 6. Kontrolleras under lasttestets topp.
- **Deploymarkörerna** i Grafana behölls.
- Cloudflare cachar inte sektionssammanfattningen (svaret har `cf-cache-status: DYNAMIC`, eftersom
  ingen cache-regel matchar vägen), därför Redis-cachen.

Att göra för hand innan lasttestet: `terraform plan` och `apply` för `helm_release.alloy`,
`helm_release.kube_prometheus_stack` och `helm_release.ingress_nginx`, och `cloudflare_ruleset.loadtest_skip`
när loadgen-VM:arna skapas. Stäng av Bot Fight Mode under testet.


## Körning 5 november: databaspoolen tog slut (grenen `loadtest-fix`)

`normal-sale` från två lastgeneratorer gick hela vägen: 48 746 bokningsförsök, 4 740 sålda biljetter
(under taket), inga dubbelsålda. CPU räckte. Men tusentals anrop fick 500.

**Två fel i k6, inte i systemet.** Första försöket dödades av lastgeneratorns minne (`Killed` vid ca
1 200 VU): varje VU tolkade hela stolsstatusen (5 000 stolar, ca 790 KB) varannan sekund. Nu laddas
pollningen ner utan att sparas, och bara den sista läsningen tolkas, med ett gjson-filter som bara
plockar ut lediga stolars id:n (`tests/load/lib/booking-flow.js`). Minnet låg sedan stilla på ca 1 GB.

**Orsaken till 500:orna.** Postgres-anslutningarna låg platt på 16 per shard hela försäljningen
(4 poddar × poolen 4), booking-api använde lite CPU och p95 var 4,96 s, alltså precis pg-poolens
`connectionTimeoutMillis` på 5 s. Anrop som väntat längre på en anslutning kastade "timeout exceeded
when trying to connect" och blev 500. Loggen visade bara `"error": {}`, eftersom felet loggades under en
nyckel som pino inte gör om till text. HPA skalade inte heller, eftersom poddarna väntade i stället för
att räkna. Planen ovan cachade stolskartan men missade att kön och eventsidan läser databasen vid varje
anrop.

**Åtgärder:**

- Kort cache per podd (2 s, med single-flight) för försäljningsfönstret och slutsåld-läget
  (`queue/join`, `queue/status`), eventsidan (`GET /events/:eventId`) och reservationskonfigurationen
  (lästes från shard 0 vid varje reservation). Fönstret räknas fortfarande från Postgres `now()`, se
  `services/booking-api/src/services/sales-window.ts`. Av när `API_CACHE_MAX_AGE_SECONDS` är 0.
- Samtidiga missar på stolsstatusen och sektionssammanfattningen i samma podd delar på en läsning.
- `DB_POOL_MAX=6` för booking-api (standard 4). Budgeten mot `max_connections`, räknad för en
  utrullning mitt i en försäljning, står i `shared/db/src/pools.ts`.
- En transaktion som rullas tillbaka lämnar nu tillbaka anslutningen till poolen. Tidigare slängdes den
  vid varje fel, också vid ett vanligt 409 "stolen är tagen", så nästa anrop fick öppna en ny anslutning
  medan poolen redan var flaskhalsen. Den slängs bara om själva ROLLBACK misslyckas.
- Betalnings- och notiskonsumenten räknar en full pool som ett tillfälligt fel: meddelandet köas om
  utan att räknas mot leveransgränsen. Under körningen hamnade 4 betalningshändelser i dödkön så.
- En full pool svarar 503 med `Retry-After` i stället för 500.
- Fel loggas med meddelande och stack, både under `err` och `error`.

**spike-sale samma dag: kontrollplanet tog slut.** booking-api och databasen klarade toppen, men noden
`tickets-cp-1` gick upp till 100 % CPU och anrop fick timeout. Det var processen `k3s-server`
(Kubernetes API-server och datastore), inte någon podd: den låg på upp till 2 kärnor, och på ca 0,9
kärnor även utan trafik. API-serverns egna mått visade 5 anrop per sekund mot `pods/log`, även utan trafik.
Det var Alloy (bekräftat: efter bytet föll `pods/log` från 5 per sekund till 0 och `k3s-server` från
ca 90 % till under 20 % utan trafik): båda Alloy-poddarna (en per nod) strömmade loggarna från ALLA poddar i klustret genom
API-servern (`loki.source.kubernetes`), alltså varje rad två gånger och genom kontrollplanet, och
öppnade strömmar på nytt när de stängdes. Nu läser varje Alloy-podd bara sin egen nods loggfiler från
disken (`/var/log/pods`), så ingen loggtrafik går via API-servern (`infra/terraform/alloy-config.alloy`).

## Mindre stolsstatus (grenen `spiketest-fix`)

Efter spike-sale var nästa flaskhals ingress-nginx på `tickets-cp-1` och lastgeneratorernas nätverk (ca
240 MB/s per maskin). Det mesta var stolsstatusen: 790 KB varannan sekund per besökare för arenans enda
sektion med 5 000 stolar. Nu har `/events/:eventId/sections/:sectionId/seats/status` en valfri `?view=`:

| Vy | Innehåll | Hämtas | Storlek (5 000 stolar), okomprimerat / gzip |
|---|---|---|---|
| `full` (standard) | som förut | av äldre klienter | 800 KB / 221 KB |
| `catalog` | id, arenaplats och pris | en gång per besök, för statusens version (`&version=`) | 610 KB / 219 KB |
| `compact` | ett tecken per stol + utgångstid per hållen stol | varannan sekund | 5 KB / 0,1 KB utan hållna, 30 KB / 1,5 KB med 500, 130 KB / 7 KB med 2 500 |

Den kompakta statusen växer med antalet hållna stolar (ca 50 byte var), men är ändå 6–160 gånger
mindre än förut. Mellan klustret och Cloudflare går svaren okomprimerade (varken booking-api eller
ingress komprimerar), så det är de okomprimerade siffrorna som ingress bär.

Samma sökväg betyder att Cloudflares befintliga cacheregel gäller (frågesträngen ingår i cachenyckeln),
så ingen Terraform-ändring behövs. Webbappen (`apps/web/src/lib/seat-status.ts`) hämtar statusen först och
katalogen sedan för exakt den versionen, slår ihop dem till samma lista som komponenterna alltid fått och
vägrar slå ihop om version eller antal skiljer sig. API:t läser om katalogen från databasen om Redis har en
annan version än den som efterfrågas. k6 hämtar på samma sätt. Motivering:
`docs/forsvar.md` "Varför är stolsstatusen uppdelad i en katalog och en kompakt status?".

