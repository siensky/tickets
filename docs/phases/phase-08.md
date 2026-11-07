# Fas 8 — efterarbete efter försvaret

**Status:** klar och mergad (`feature/fas8`, PR #23). Steg 8.7 (Tempo) byggdes men togs bort igen efter
lasttestet. **Utfall:** [`phase-status.md`](../phase-status.md) "Fas 8 — efterarbete" och "Efter Fas 8 — …".

## Mål

Inget eget mål i fastabellen (kolumnen var tom). Det mätbara "klart när" står i 8.11.

## Omfattning

Efterarbete på redan klara delar, i EN branch (`feature/fas8`): snabbare CI, Auth0-inloggningens utseende, luckorna från Fas 7, maskerad session replay, adaptivt botskydd (proof of work + Turnstile), DLQ för RabbitMQ, och Tempo. Se **"Fas 8 — detaljplan"** nedan.

## Beroenden

Fas 7 mergad. Manuella förutsättningar i 8.10.

## Berör

[`specification.md`](../specification.md): "Väntrum och botskydd", "Idempotens och meddelanden",
"Realtid", "Frontend", "Observability och backups".

## Implementationssteg

Stegen nedan är detaljplanen ordagrant som den stod i `plan.md` (senast i commit `be65709`). Kodens
hänvisningar `plan.md 8.N` avser steg 8.N här.

Allt byggs i **en branch, `feature/fas8`**, enligt fas-arbetsflödet (plan → bygg → test → review → fix →
rapport) och i exakt den ordning som står i 8.9. Ordningen är vald så att de små och säkra delarna kommer
först och sådant som ändrar produktionens tillstånd kommer sist. **Mergas efter försvaret 4/11**, aldrig
under demo- eller försvarsdagar. Varje steg pushas och måste ha grön CI innan nästa börjar, och de riskfyllda delarna (8.3-cachen, 8.5) ligger
bakom en kill switch (miljövariabel eller `config`), så de kan stängas av utan ny deploy. Gemensamma regler är desamma som i 7.18 (additiva API- och DB-ändringar,
inga nya designbeslut utan att fråga, inga secrets i kod). Beslut av användaren 2/11: ArgoCD, Sealed Secrets,
k3s-uppgradering, AI-kundtjänst och cluster-autoscaler görs **inte** i Fas 8.

**8.1 Snabbare CI.** Mätt 2/11 (`gh run view`): CI på en PR tar ca 4,5 min (kritiska vägen är jobbet `e2e`:
~1,5 min uppsättning, e2e-sviten ~1,75 min, systemtester ~1,5 min), deploy efter merge ca 9 min (tester körs
om på `main` ~5 min, images ~2 min, deploy ~2 min). De två långsamma bitarna är de som *väntar* på att en
reservation ska gå ut: systemtestet F5 (~1,5 min) och e2e-specen `reservation-expiry` (~1 min). Åtgärd,
utan att ta bort eller försvaga något test:
- `e2e.yml` delas i tre parallella jobb som alla startar sin egen stack: **e2e** (alla specar utom
  `reservation-expiry` + alla systemtester utom F5), **e2e-expiry** (bara `reservation-expiry`) och
  **system-expiry** (bara F5). Playwright använder `--grep`/`--grep-invert` på en tagg `@slow`; vitest
  använder två skript (`test:system:fast`, `test:system:slow`). Invarianterna körs i varje systemtestjobb över
  det jobbets egna events.
- `test.yml` delas i två parallella jobb: **static** (lint, lagergränser, secret-namnrymder, typecheck) och
  **tests** (unit, cdn-Worker, integration, Pact).
- Ett sammanfattande jobb **`ci-ok`** (`if: always()`, misslyckas om något `needs.*.result` är `failure`,
  `cancelled` eller `skipped`) i `ci.yml` över `test`, `e2e`, `k8s-dry-run` och `docker-build`. `deploy.yml` är
  oförändrad: dess `needs: [test, e2e]` fungerar som förut, eftersom ett reusable-workflow-anrop bara är grönt när
  alla dess interna jobb (`static`, `tests` och alla tre matrisben) är gröna.
- Mål: PR ca 3 min (från 4,5), deploy ca 7 min (från 9). Ingen test tas bort, ingen assertion ändras.
- **Grenskydd:** repot har inget grenskydd (kontrollerat 2/11), så inga required checks behöver bytas. Läggs ett
  skydd till senare är `ci-ok` den check som ska krävas. Auth0-inloggningar sprids på tre jobb samtidigt (password grant mot
  CI-appen, tokens cachas per jobb): Auth0-loggarna kontrolleras efter rate limit- eller brute-force-fel.
  Varje jobb använder egna events, så invarianterna bryts inte.
- Verifiering (mätbart): fem gröna CI-körningar i rad utan Auth0-fel; p95 för PR-CI högst 3,5 min och för
  deploy högst 8 min, jämfört med dagens 4,5 respektive 9 min.

**8.2 Auth0-inloggningens utseende.** Rubriken "Log in to dev-… to continue to Tickets Web" och Auth0-loggan
kommer från tenantens visningsnamn, applikationens namn och tenantens logga, inte från vår kod. Ändras i
Auth0 (steg-för-steg-guide i `docs/runbook.md` "Auth0: inloggningens utseende"):
1. **Branding → Universal Login:** logga = tikknet-loggan från `https://cdn.tikknet.se/brand/tikknet-logo.svg`,
   primärfärg `#c30048`, sidans bakgrund i temats basfärg.
2. **Settings → General:** tenantens visningsnamn "tikknet" (ersätter `dev-…`-namnet i rubriken).
3. **Applications:** byt "Tickets Web" till "tikknet" och "Scanner" till "tikknet scanner".
4. **Text:** anpassa rubrik- och knapptexter och sätt språket till svenska (exakta menyer verifieras när steget
   byggs; kan kräva Management API för vissa texter).
- Kod: `ui_locales: 'sv'` i `authorizationParams` i webbappen och scannern. Bara det utseendemässiga
  ändras; flödet är oförändrat. Egen domän för inloggningen (`login.tikknet.se`) görs inte nu.
- **Görs efter försvaret, med dagens värden antecknade i runbooken före ändring (rollback). Refresh Token
  Rotation ändrar tokenbeteendet för redan inloggade scannrar, så den testas på en riktig iPhone före nästa demo.**
- **iOS-inloggning i scannern:** `useRefreshTokens` + `useRefreshTokensFallback` påslaget i scannern.
  Manuellt i Auth0: Scanner-appen → *Refresh Token Rotation* på, API:t → *Allow Offline Access* på.

**8.3 Luckorna från Fas 7.**
- **`GET /events` och `/sections/summary`:** styrs av miljövariabeln `API_CACHE_MAX_AGE_SECONDS` (0 = ingen cache,
  standard lokalt och i CI så att e2e och systemtester aldrig ser en cachad lista; `10` i produktionsmanifestet).
  *Avvikelse från första utkastet (beslutad vid bygget, anledning i `docs/forsvar.md`):* eventlistan cachas i **Redis**
  (10 s, fail-open, aldrig fritextsök) och inte vid Cloudflares kant, eftersom den anropas från två origins (webb och
  scanner) och Cloudflare inte följer `Vary: Origin`, så ett cachat svar kunde få fel CORS-header.
  `sections/summary` får `Cache-Control: public, max-age=5` utan stale-while-revalidate, `Access-Control-Allow-Origin: *`
  (samma svar för alla, Cloudflare följer inte `Vary: Origin`) och en Cloudflare Cache Rule med `respect_origin`, så att
  kill switchen (`0` = ingen header) också stänger av kantcachen. Samma `*`-header sätts på de redan kantcachade routes
  för geometri och stolsstatus. Svaret får aldrig bero på `Authorization` eller `x-queue-token`; ett test bevisar att
  listan är identisk med och utan token. Reservationsanropet är fortfarande sanningen för om en plats går att boka.
- **cdn-Workern:** svarar `304` på `If-None-Match` (`get(key, { onlyIf })`) och cachar vid kanten (Cache API, med
  origin i cache-nyckeln eftersom CORS-headern beror på den) bara svar 200/304 (aldrig 404): kort TTL (300 s) för
  `brand/` (oförändrade filnamn), längre för `images/`. Samma vitlista som idag. Tester för 304, 404 och ändrad ETag i `cdn-proxy.test.js`.
- **Grafana-annotationen:** byts till ett uttryck som bara triggas av en ny ReplicaSet (en riktig deploy),
  t.ex. `changes(kube_replicaset_created{...}[1m]) > 0`, inte av HPA-skalning. Verifieras i båda fallen: en
  `rollout restart` ger en annotation, en manuell skalning av HPA ger ingen.
- **De 5 gamla demo-eventen** (id `…0201`–`…0205`, 30-sätesarenan, utan bild) tas bort ur produktion med ett
  engångsskript `remove-demo-events.ts` (torrkörning först som listar vad som tas bort, sedan `--apply`),
  körs manuellt av användaren efter bekräftelse (beslut 2/11: **byggs först av allt i Fas 8** och får köras
  redan före försvaret, eftersom det är ett fristående skript som inte kräver någon deploy; aldrig mitt under en demo). Skriptet kör per event en
  transaktion med eventraden låst, vägrar det eventet om det har betalda eller pågående ordrar/reservationer
  (`paid`/`pending`, `active`/`pending_payment`; en väntande order kan ha en öppen Stripe Checkout), exporterar raderna
  till en fil (0600, i hemkatalogen, aldrig i repot) före första DELETE, och tömmer väntrummets Redis-nycklar. Går att
  köra om (saknade event hoppas över). Rör aldrig lasttestets event eller CSV-eventen. Lasttestet
  påverkas inte: det kör mot eget event (`reset-sale`) och eget 5 000-platsersvenue.
- **Pact fångar inte driftkonfiguration** (t.ex. fel webhook-secret): dokumenteras i `docs/forsvar.md`;
  `loadtest-mode`s betalningskontroll täcker det. Ingen ny kod.

**8.4 Maskerad session replay (PostHog).** Av idag. Påslaget **bara efter samtycke** (samma regel som
flaggor) och med allt maskerat: `maskAllInputs`, `maskTextSelector: '*'`, och blockering av QR-modalen,
checkout-sidan och Mina biljetter (`ph-no-capture`). Nätverksinspelning av headers och body är av
(`recordHeaders: false`, `recordBody: false`) och URL:er rensas på `code`, `state`, `q` och kötoken. Banner- och integritetstexten uppdateras ("sessionsinspelning
med maskerad text"). Manuellt: *Session replay* påslaget i PostHog-projektet. Enhetstest för att replay inte
startar utan samtycke; e2e kontrollerar att ingen inspelningstrafik skickas före "Godkänn" och att den slutar efter återkallat
samtycke.

**8.5 Adaptivt botskydd (proof of work + Turnstile).** Eskalering i `POST /events/:eventId/queue/join`,
alltid efter rate limitern. Nivåerna räknas ur signaler vi redan har i Redis (inga nya tjänster):
- **Signaler:** (1) IP:n har gjort fler än 30 `queue/join`-försök under senaste minuten (varje försök räknas, även ett med
  "bevis"; **avvikelse från första planen**: ett eget räknarmått på just join i stället för 50 % av det generella
  rate-limit-taket, som är för grovt för att skilja en bot från en vanlig besökare); (2) samma IP har
  reserverat fler än 10 joins för samma event på 10 min (en människa går med en gång; reservationen görs atomiskt
  med `INCR` före joinen och frigörs vid ett `428` eller en misslyckad join, så ett `428` räknas aldrig och en salva
  parallella requests inte alla ser 0). **Signal 1 och 2 räknas som EN signal** (IP-volym) vid nivåbeslutet, så ett delat
  nät (klassrum, CGNAT) ensamt ger högst nivå 1; (3) kön är under globalt tryck (ködjup eller join-takt över ett tröskelvärde) —
  **avstängd som standard** (värde 0 i `config`) tills den mätts, eftersom den annars utmanar alla under
  samma rush som demon och lasttestet; (4) saknad eller uppenbart automatisk `User-Agent` (ankrad mot kända skriptklienter, inte lösa delsträngar).
- **Nivå 0** (inga signaler): ingen utmaning, som idag. **Nivå 1** (en svag signal): *proof of work*. Servern
  svarar `428 Precondition Required` med en utmaning: en HMAC-signerad sträng över `ip|eventId|utgångstid`
  (stateless) och en svårighet; webbläsaren löser det osynligt (SHA-256 med N inledande nollbitar, ca 0,3 s)
  och försöker igen med lösningen. Varje lösning kan användas **en gång** (Redis `SET NX` med TTL), är bunden
  till IP och event och går ut efter kort tid. Inget får ha en bieffekt före verifieringen, så omförsök är säkra.
  **Nivå 2** (stark eller upprepad signal): *Cloudflare Turnstile*. Servern kräver ett Turnstile-token som
  verifieras mot `siteverify` med timeout 2 s, och svaret valideras (`success`, `action`, `hostname`). Är
  Turnstile nere nekas nivå 2-förfrågan (fail-closed) men nivå 0–1 påverkas aldrig (inget externt beroende på
  normalvägen).
- **Kill switch:** `challenge_enabled` i `config` (standard på; av = alla nivåer 0) och tröskelvärdena ligger
  där också, så allt kan ändras utan deploy. Lasttestet och k6 får ett undantag via en delad hemlig header
  (lång slumpad sträng, jämförs i konstant tid, loggas) som `loadtest-mode` sätter och tar bort, samma mönster
  som allowlisten. e2e-seeden höjer IP-trösklarna till 100000 (alla webbläsartester kommer från en IP) och systemtestens/e2e-hjälparnas
  API-anrop skickar bypass-headern; standardtrösklarna och alla tre nivåerna täcks i stället av integrationstestet
  mot riktiga Postgres/Redis, och `challenge.spec.ts` bevisar webbens osynliga PoW-lösning med tröskeln satt till 0.
- Webb: en `ChallengeGate` på kösidan hanterar `428` generellt, visar Turnstile bara vid nivå 2 och löser PoW
  utan UI. PWA:ns service worker uppdateras (`autoUpdate`), så en gammal cachad klient inte får ett hårt fel;
  scannern och realtime-gateway använder inte `queue/join`. Händelserna `challenge_shown` och
  `challenge_passed` till PostHog.
- Tester: unit för nivåberäkningen och PoW-verifieringen (inklusive återanvänd och utgången lösning),
  integration för `queue/join` på alla tre nivåerna (Testcontainers), e2e för att en normal användare aldrig ser
  en utmaning, Pact får både `200` och `428`.
- Mätbart krav: i en lasttestkörning med normal trafik (med undantaget av) visas ingen utmaning, och
  `challenge_shown` ligger under 1 % av sessionerna i produktion.
- Hemligheter: `TURNSTILE_SECRET_KEY` läggs i `tickets-app-secrets` via `deploy.yml` (och
  `verify-secret-namespaces` uppdateras). `VITE_TURNSTILE_SITE_KEY` är publik. Manuellt (användaren):
  Cloudflare → *Turnstile* → Add widget för `tikknet.se`; Turnstiles testnycklar används i e2e.

**8.6 DLQ för RabbitMQ.** Idag har köerna `x-delivery-limit` men **ingen dead-letter-exchange**: ett meddelande
som överskrider gränsen **försvinner** (bara en loggrad). En policy kan bara *peka* på en exchange, den skapar
ingen, och en köes argument kan inte ändras efter att den skapats (omdeklarering ger `PRECONDITION_FAILED`).
Därför:
- **Topologin deklareras i koden** (additivt, ändrar inga argument): `setUpQueue` i `shared/rabbit/src/consumer.ts`
  skapar en direct-exchange `tickets.dlx` och en kö `<kö>.dead` bunden med routing key `<kö>`. Samma kod körs i
  Testcontainers, så testet bevisar produktionens uppsättning.
- **Policyn sätts per kö** (en policy per kö). **Avvikelse från första planen (verifierat i Docker):** `load_definitions`
  kraschar RabbitMQs boot ("Please create virtual host /") och ett init-Job hade krävt mer maskineri, så
  policyerna ligger i `infra/k8s/base/rabbitmq/definitions.json` och importeras idempotent av en `postStart`-hook
  (`rabbitmqctl import_definitions`, rör varken användare eller köer; hooken avslutar alltid med 0 och larmet
  `RabbitMQDeadLetterPolicyMissing` fångar ett misslyckande). Pris: en ändrad policy rullar om den enda repliken.
  Mönstret är exakt per kö och matchar därför aldrig `.dead`; ett enhetstest kräver en policy för varje kö i koden.
  Konsumenten räknar dessutom själv försök via `x-acquired-count` (RabbitMQ 4 räknar inte `nack requeue=true`
  mot `x-delivery-limit`, verifierat) och nackar med requeue=false på sista försöket; `SHARD_UNAVAILABLE` räknas
  inte. Tidigare plan: ett init-Job med `rabbitmqctl set_policy`:
  `dead-letter-exchange=tickets.dlx`, `dead-letter-routing-key=<kö>`, `apply-to=queues`, med ett mönster som
  *undantar* `.dead`-köerna så att det aldrig blir en loop.
- Den inbyggda RabbitMQ-managementvyn (port-forward `15672`) visar de döda köerna och deras meddelanden utan egen
  UI. Ingen adminvy byggs. Pluginerna `rabbitmq_shovel` **och** `rabbitmq_shovel_management` slås på så att
  "Move messages" finns för att spela upp ett meddelande igen. `enabled_plugins` är en ConfigMap med `subPath`
  och kräver en omstart av den enda RabbitMQ-repliken (några sekunders avbrott i bokningsflödet): görs i en
  egen, övervakad deploy, aldrig på en demodag. Minnesgränsen på 768Mi kontrolleras efteråt.
- Grafana: panel "Döda meddelanden" och ett larm till Slack när någon dödkö är icke-tom. Per-kö-måtten kräver
  `prometheus.return_per_object_metrics = true` (annars aggregeras de bort och larmet blir tyst).
  Larmet testas genom att ett dött meddelande publiceras och Slack-larmet avfyras. Runbook "RabbitMQ: döda
  meddelanden" (se, spela upp, radera).
- Tester (Testcontainers, riktig RabbitMQ): en konsument som nackar tills gränsen nås lämnar meddelandet i
  dödkön med rätt routing key; en befintlig kö med gamla argument ger inte `PRECONDITION_FAILED`.

**8.7 Tempo (traces).** Alloy tar redan emot OTLP-spans från alla tjänster och skickar dem till en
debug-exportör. Noderna är små (cpx22, 2 vCPU/4 GB) och `chunksCache` har redan fått tas bort för minnets skull,
så resurserna är hårda krav:
- Tempo som single-binary i `observability` (Terraform/Helm, samma mönster som Loki) med `requests` 128Mi och
  `limits` 384Mi (plus `GOMEMLIMIT`), en PVC på 5Gi med 7 dagars retention (Tempo har ingen `retentionSize`; diskens tak är
  PVC:n och larmet `TempoVolumeFilling` vid 80 %), och **sampling 10 %**
  (`probabilistic_sampler` i Alloy, ändringsbart). Alloy exporterar till Tempo, Grafana får Tempo som datakälla
  med koppling mellan traces och Loki-loggar (`traceId`).
- **Debug-exportören behålls** tills Tempo är bevisad; borttagningen och sänkningen av
  `alloy.stabilityLevel: experimental` görs i en egen sista commit. Rollback: Terraform-variabeln `tempo_enabled=false`
  (Tempo-releasen får `count = 0`, Alloy-konfigurationen renderas som mall utan Tempo-delen) + `terraform apply -target`.
  Chart: `grafana-community/tempo` 3.2.0 (Tempo 3.1.0, 19 dagar gammal; 3.2.1 var yngre än två veckor).
- Acceptans (mäts före merge, inte under lasttest första gången): `kubectl top nodes` före och efter, inga
  `Pending`-poddar, inga OOM-kills, och ett bokningsanrop syns som ett trace med minst spans för booking-api,
  `pg` och `ioredis` i Grafana Explore (auto-instrumenteringen verifieras, annars justeras den).
- Applicera med `terraform apply -target` (användaren), Tempo först, därefter Alloy-konfigurationen, därefter
  app-deployen.

**8.8 Punkt-i-tid-återställning — skippas (beslut 2/11).** Den nattliga `pg_dump` räcker för projektet (RPO upp till 24 h, RTO mätt). Tas upp igen bara om kraven ändras.

**8.9 Byggordning** (en branch, push efter varje steg och grön CI innan nästa):

| # | Steg | Risk | Anledning till platsen |
|---|---|---|---|
| 0 | 8.3 (bara demo-event-skriptet) | låg | fristående skript, kan köras av användaren direkt, före allt annat |
| 1 | 8.1 Snabbare CI | låg | gör alla följande steg snabbare att verifiera |
| 2 | 8.2 Auth0-utseende + refresh tokens | låg | mest manuellt i Auth0, lite kod |
| 3 | 8.3 Luckorna (cache, 304, annotation, demo-event) | låg–medel | rör inte bokningen, demo-event kräver bekräftelse |
| 4 | 8.4 Session replay | låg | bakom samtycke |
| 5 | 8.6 DLQ | medel | ren säkerhetsförbättring utan användarpåverkan, före botskyddet |
| 6 | 8.5 Botskydd | medel | rör `queue/join`, bakom kill switch, testas mot lasttestet med undantaget |
| 7 | 8.7 Tempo | medel | ny tjänst i klustret, minnes- och diskpåverkan mäts |

**8.10 Manuella förutsättningar** (användaren, guider när respektive steg börjar): Auth0-branding och
Refresh Token Rotation (8.2), PostHog *Session replay* (8.4), Cloudflare Turnstile-widget och secrets (8.5),
`terraform apply` för Tempo och Cache Rule (8.3, 8.7), bekräftelse innan demo-event tas bort (8.3).
**Tillämpningsordning efter merge (efter 4/11, aldrig under en demodag):** (1) `terraform apply` för Tempo, därefter
Alloy-konfigurationen, och Cloudflare Cache Rule (utan origin-headers har den ingen effekt); (2) app-deployen
(merge till `main`); (3) RabbitMQ-pluginerna och policyerna (importeras av `postStart`-hooken; kort omstart av den enda repliken); (4) Auth0-ändringarna (8.2);
(5) borttagningen av demo-event (8.3) kan köras redan innan merge (steg 0). Det finns ingen deploy-kedja för Terraform i `deploy.yml`, så (1) körs för hand.

**8.11 Klart när (mätbart):** PR-CI p95 högst 3,5 min och deploy högst 8 min utan att något test tagits bort;
inloggningen visar tikknet-namn och -logga; eventlistan har cache i produktion och cdn svarar 304; en
bot-liknande klient får en utmaning medan normal trafik och lasttestet (med undantaget) ger 0 utmaningar; ett
dött meddelande syns i RabbitMQ och i Grafana och ger ett Slack-larm; ett trace med spans för booking-api, `pg`
och `ioredis` syns i Grafana utan Pending-poddar eller OOM-kills; ingen session replay-trafik skickas utan samtycke.

**Status (byggd 2/11 på `feature/fas8`, inte mergad före försvaret):**

| # | Steg | Status |
|---|---|---|
| 0 | Demo-event-skriptet (8.3) | ✅ byggt, granskat, fixat; körs av användaren (`remove-demo-events`, torrkörning som standard) |
| 1 | Snabbare CI (8.1) | ✅ byggt: matris `fast`/`e2e-expiry`/`system-expiry`, `ci-ok`; tid mäts i första PR-körningen |
| 2 | Auth0 (8.2) | ✅ kod (`ui_locales`, refresh tokens i scannern); Auth0-branding och Refresh Token Rotation är manuella steg |
| 3 | Luckorna (8.3) | ✅ eventlistcache i Redis, `Cache-Control` på sektionssammanfattning, cdn-304 via Cache API, deploy-annotation; Terraform-regeln appliceras manuellt |
| 4 | Session replay (8.4) | ✅ maskerad, bakom samtycke; kräver PostHog-inställningen *Session replay* |
| 5 | DLQ (8.6) | ✅ dödköer + policyer + larm + panel; policyerna importeras av `postStart`-hook (avvikelse från init-Job) |
| 6 | Botskydd (8.5) | ✅ PoW + Turnstile + kill switch + bypass; kräver Turnstile-widget och secrets för nivå 2 |
| 7 | Tempo (8.7) | ✅ Terraform/Helm + Alloy-mall + datakällor + larm; appliceras och mäts manuellt (före/efter) |

**Kända luckor / framtid (efter Fas 8):** IPv6 bör normaliseras till /64 för botskyddets nycklar och PoW-bindning
(ett /64 roterar annars fritt, och en användare som byter adress mellan 428 och omförsök får en ogiltig lösning);
dödköerna saknar `x-max-length` och `dead-letter-strategy: at-least-once` (dead-lettering i quorum-köer är som
standard at-most-once); Turnstile är låst till hostnamnet `tikknet.se`; Tempo saknar storleksbaserad retention
(PVC + larm är taket); sänkningen av `alloy.stabilityLevel: experimental` och borttagningen av debug-exportören
görs när Tempo är bevisad.

## Acceptanskriterier

Se 8.11 ("Klart när (mätbart)") ovan.
