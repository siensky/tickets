# Fasstatus mellan sessioner

Kort kontext nästa session behöver utöver `docs/plan.md` själv (docs/rules.md §11a).
Läs båda innan en ny fas påbörjas.

## Fas 7, steg 2 — mätbarhet (`feature/fas7-matbarhet`)

- `helm.tf`: ingress-nginx `controller.metrics` + `serviceMonitor` på (+ `depends_on` kube_prometheus_stack, som äger ServiceMonitor-CRD:n). Applicera `-target=helm_release.ingress_nginx`.
- `dashboards.yaml` ("Autoscaling & lasttest"): demo-panel (repliker + CPU % av request + request rate), zero-downtime-rad (ingress-5xx/s, ready-repliker, ingress request rate), deploy-annotation. Ingress-5xx exkluderar `metrics-blackhole` (`/metrics` svarar medvetet 503) och visar 0 bara när måtten skrapas.
- `runbook.md`: restore-övningen körs i en tillfällig podd i `data`. **RPO/RTO-tabellen är fortfarande ofylld**: användaren kör övningen och verifierar panelerna i Grafana.
- Öppet: deploy-annotationen (planens uttryck) triggas även av HPA-skalning, se rapporten.

## Fas 7, steg 1c — cdn (`feature/fas7-cdn`)

- `workers/cdn-proxy.js` (vitlista `images/` + `brand/`, 404 för allt annat inkl. `..` och URL-kodade
  varianter, cache `max-age=86400`, CORS från apex och `scan.` via bindingen `ALLOWED_ORIGINS`) och
  `cdn-proxy.test.js`, som körs av ett eget steg i `test.yml` (ligger utanför turbo-paketen).
- `cloudflare-frontend.tf`: ny Worker + `cloudflare_workers_custom_domain` för `cdn.<domän>`.
- `deploy-frontend` laddar bara upp `brand/`. `images/` byggs i steg 6 (7.6).
- Efter merge: `terraform apply`, en deploy (laddar upp `brand/`), sedan `curl`-listan i runbooken.

## Fas 7, steg 1b — drift (`feature/fas7-drift`)

- Cloud-init (loadgen): eget `GNUPGHOME`, `dirmngr` startas, retry-loop, `command -v k6 || exit 1`.
- payment-mock CPU-gräns 500m (övriga 7.1-värden fanns redan från hotfixes).
- `scripts/loadtest-mode.sh on [rate]|off` (se runbook). Insläppsvärdet återställs alltid till 300.
- Loki `auth_enabled = false`. Beslut utöver planen: Alloy-chartets `serviceMonitor` på (+ `depends_on`
  kube_prometheus_stack), annars skrapas inte `loki_write_dropped_entries_total` och larmet
  `AlloyLogEntriesDropped` kan inte utlösas. Applicera loki + alloy; verifiera måttnamnet i Prometheus.
- Känt för steg 3: `on` lämnar en literal `STRIPE_WEBHOOK_SECRET`; en riktig deploy under `on` failar.

## Fas 7, steg 1a — snabbare CI (`feature/fas7-ci`)

Fas 7:s steg 1 är delat i 1a (CI), 1b (drift: 7.1 + 7.2) och 1c (cdn, 7.19), en branch
vardera (docs/plan.md 7.16, docs/rules.md §10). 1a är byggt:
- `e2e.yml`: Playwrights webbläsare cachas på Playwright-versionen (läses ur
  `playwright --version`). Vid träff körs bara `install-deps`.
- `deploy.yml`: `build-and-push` är en matris över sex images (inte fem: migrations
  ingår), cache scopad per image. `sha`-outputen skrivs av alla ben (samma värde).
- Matrisen körs bara på push till `main`; CI testar den inte. Första deployen går utan
  cache, mät tiden på den andra. Cachekvoten (10 GB) kan fyllas av sex `mode=max`-cacher.
- Beslut: 1c laddar bara upp `brand/`. Uppladdningen av `seed/images/` byggs i steg 6 (7.6).

## Riktig lasttestkörning, första försöket (efter Fas 6)

`seed-real-venue.ts` (ny, samma mönster som seed-demo-events.ts/
csv-ticket-import-repository.ts) byggdes och pushades direkt till `main`
(på uttrycklig begäran, undantag från den annars gällande regeln att
användaren alltid committar/pushar själv) för att lösa det kvarstående
gapet: inget skript skapade en "riktig" 5 000-sätes venue innan
CSV-importen kunde köras mot ett riktigt event.

**Hittat live under den första riktiga körningen mot klustret:**
`infra/terraform/cloud-init/loadgen.yaml.tftpl` installerade `curl`/
`gnupg` men inte `dirmngr` — `gpg --keyserver ... --recv-keys` kan då
inte nå en keyserver alls (`can't connect to the dirmngr`), k6:s
apt-nyckel importerades aldrig, repot avvisades som osignerat, och
`apt-get install k6` floppade med "Unable to locate package k6" på
ALLA TRE lastgeneratorerna i samma körning. Fixat: `dirmngr` tillagd i
`packages:`. De tre redan uppe VM:erna fick k6 installerat manuellt via
SSH (apt-get install dirmngr + om-körd gpg/apt-get-sekvens) i stället
för att vänta på en ny `terraform apply`/omstart.

**Också hittat:** att `terraform apply -var="loadgen_node_count=3"`
(utan `-target`) planerade om att ERSÄTTA `control_plane`/`workers[0]`
(`user_data` "forces replacement") — nästan säkert eftersom
`TF_VAR_tailscale_node_authkey` i den aktuella terminalsessionen skiljer
sig från vad som bakades in i noden vid dess senaste skapande (ingen
default, sätts bara via env var, se `variables.tf`). Löst genom att
ALDRIG köra den fulla planen, bara `-target=hcloud_server.loadgen
-target=hcloud_firewall.loadgen` (DNS-posten för `loadtest.tikknet.se`
uteslöts medvetet, eftersom dess `for_each` drar in nodernas IP:n som
beroende och därmed drar in hela ersättningsplanen igen) — pekade i
stället `loadtest.tikknet.se` mot `control_plane`s publika IP via
`/etc/hosts` på varje generator-VM, eftersom Ingress/TLS-certet för det
hostnamnet redan fanns sedan deploy. Samma mekanism (env-var-drift på
`tailscale_node_authkey`) förklarar troligen varför `tailscale status`
visar fyra döda `tickets-cp-1-x`-enheter sedan tidigare — detta har
hänt förut.

**Separat:** `admin_ipv4_cidr` i `terraform.tfvars` var inaktuell (gammal
IP), vilket gjorde att SSH mot både klustret och lastgeneratorerna
tystnade helt (brandväggen släppte inte igenom, inget felmeddelande).
Måste uppdateras varje gång den lokala maskinens publika IP ändras —
inget skript bevakar detta.

## CSV-biljettimport (egen liten gren, efter Fas 6)

Byggd på `feature/csv-ticket-import` (inte `feature/fas6`/`main` direkt, på
uttrycklig begäran): `services/scheduler-worker/src/scripts/import-tickets.ts` +
`src/repositories/csv-ticket-import-repository.ts`. Läser en CSV, validerar
exakt 5 000 rader/inga dubbletter/inget annat separatortecken än radbrytning,
`INSERT ... ON CONFLICT (event_id, ticket_number) DO NOTHING` — idempotent, och
en omkörning som skulle skriva ANNAN data (annat pris, annan venue) avbryts nu
explicit i stället för att tyst rapportera "0 nya" (hittat i review, se nedan).

Den riktiga uppgiftens CSV-format är okänt (bekräftat med användaren) — skriptet
antar en kolumn (`ticket_number` per rad) och parar ihop raderna POSITIONELLT,
i filordning, mot venuets `venue_seats` i en fixerad ordning (sektion →
`display_order`/id → rad (text, lexikografisk) → platsnummer/id). Dokumenterat
som ett antagande i skriptets egen header, inte en bekräftad sanning. INGET
skript seedar ännu en "riktig" 5 000-sätes venue — bara 30-sätes demo-venuen
(seed-demo-events.ts) finns. Se docs/plan.md "Fas 6 — kända luckor".

Reviewad av en oberoende subagent (code-safety-reviewer): inga Kritiska/Höga
fynd. Fixat: för löst separatorval (bara komma kollades, inte `;`/citat),
icke-deterministisk sekvensordning (display_order saknade tie-breaker),
`as`-cast utan kommentar (§2), `main()` nära 50-radersgränsen (extraherat),
`parsePriceCents` accepterade `1e3`/hex/decimaler och saknade övre gräns,
`eventId` normaliserades inte (case/format). Manuellt end-to-end-testat mot en
riktig lokal Postgres (docker-compose): happy path, omkörning (idempotent),
fel radantal, dubblett, fel separator, obefintligt event, pris 0,
venue-storleksmismatch (1 säte ist. för 5000) — alla gav tydliga, korrekta fel.
Typecheck/lint/boundaries/secret-namespaces gröna. INTE körd mot ett riktigt
kluster (samma Tailscale-begränsning som resten av Fas 6).

## Läget efter Fas 6

**Grafana byggdes ut EFTER den initiala Fas 6-leveransen, på uttrycklig begäran**
(användaren frågade "kan jag se allt det här i Grafana?" efter rapporten): saknade
tidigare helt en panel för replikantal/HPA-kurva, och de fyra affärsmåtten
("aktiva reservationer, insläppstakt, sålda biljetter, konverteringsgrad",
docs/plan.md "Vad som mäts") fanns fortfarande inte i koden (bara flaggat som en
lucka sedan Fas 4). Nu: `shared/observability/src/metrics.ts`s `createBusinessMetrics`
(`active_reservations`/`sold_tickets`/`waiting_room_depth` som Gauges — kan gå NER,
till skillnad från Counters; `queue_joins_total`/`queue_admissions_total` som
Counters). Satta från `services/booking-api/src/services/queue-service.ts` (join) och
`services/scheduler-worker/src/services/queue-admission-service.ts` (ködjup,
insläpp) samt en NY periodisk job `business-metrics-service.ts` (samma
`setInterval`-mönster som reservation-release-service.ts, 5 s, `.reset()` före varje
tick så en grupp som går till noll inte fastnar på sitt sista värde — GROUP BY
returnerar inga rader för en tom grupp). SQL i en ny `repositories/
business-metrics-repository.ts`. Två nya Grafana-dashboards/utökningar i
`infra/k8s/base/monitoring/dashboards.yaml`: "Business" fick 5 nya paneler
(ködjup, insläppstakt, aktiva reservationer, sålda biljetter vs. 5000-taket,
konverteringsgrad), och en helt ny "Autoscaling & lasttest"-dashboard (replikkurva
via `kube_deployment_status_replicas` — samma metrik för HPA OCH KEDA eftersom båda
bara skalar den underliggande Deploymenten, HPA min/max per tjänst, CPU/minne per
podd mot tröskel, podd-omstarter, nod-CPU/minne). Allt OVERIFIERAT mot ett riktigt
kluster (samma Tailscale-begränsning). `services/booking-api/src/index.ts` passerade
300-radersgränsen av tillägget — `Dependencies`/`loadDependencies`/`requireEnv`/
`createStripeClientFromEnv` flyttade till en ny `dependencies.ts` i samma mapp.
`eslint.config.js`s `service-root`-boundaries-typ vidgades från `index.ts` specifikt
till `*.ts` (en ensam `*`, spänner inte `/`) för att täcka den nya filen OCH
`instrumentation.ts` (fanns redan i alla fem tjänster, var tidigare obevakad av
exakt samma skäl som `scripts/`-gapet ovan) — en policy för `service-root` → `service-root`
lades till samtidigt (`index.ts` importerar nu från `dependencies.ts`).

**Autoscaling byggt, inget uppmätt mot ett riktigt kluster** (samma gräns som Fas 4):
HPA på booking-api (CPU 70 %) och realtime-gateway (minne 70 % av 320Mi — höjt från
256Mi i reviewn, Node+OTel ligger ofta redan nära det i vila, ändå overifierat), KEDA
`ScaledObject` + `TriggerAuthentication` på notification-worker (RabbitMQ-ködjup, se
`infra/k8s/base/notification-worker/scaledobject.yaml` — `advanced.horizontalPodAutoscalerConfig.behavior`
krävs explicit för att 60 s-nedskalningsfönstret faktiskt ska gälla, `cooldownPeriod`
styr bara skala-till-0). **Viktigt upptäckt i reviewn:** `spec.replicas` TAS INTE MED i
booking-api/realtime-gateway/notification-worker-deploymenterna längre — står det kvar
skriver `kubectl apply` tillbaka ett statiskt tal över HPA:ns/KEDA:s löpande beslut vid
VARJE deploy (inte bara en engångsdipp, som en nu rättad kommentar tidigare påstod
baklänges).

**Lasttest-infrastruktur byggd, ALDRIG körd** (ingen k6-binär eller kluster i
byggmiljön): `tests/load/{smoke,queue-storm,normal-sale,spike-sale}.js` +
`lib/{config,booking-flow}.js`, `deploy-under-load.js`/`shard-failure.js` återexporterar
normal-sale. `queue-storm.js` använder en RIKTIG WebSocket (`k6/ws`) mot
realtime-gateway — särskilt overifierad, smoke-testa den specifikt först.
`queue_admission_rate_per_minute` MÅSTE höjas live (config-tabellen) innan
normal-sale/spike-sale körs på riktigt, annars växer kön obegränsat (se kommentaren i
normal-sale.js) — inget skript gör detta automatiskt. Terraform: `hcloud_server.loadgen`
(egen brandvägg, `hcloud_firewall.loadgen` — en delad brandvägg med klustret hade gett
en beroendecykel), `loadtest.<domän>`-DNS-posten är villkorad på `loadgen_node_count > 0`.
Reset/rapport-skript: `services/scheduler-worker/src/scripts/{reset-sale,generate-sale-report,seed-demo-events}.ts`
— ny mapp, `scripts` registrerad i `eslint.config.js`:s `boundaries/elements` (saknades
helt innan reviewn, samma riskklass som den tidigare `boundaries/root-path`-regressionen).
All SQL i den mappen flyttad till `repositories/sale-reset-repository.ts`/
`sale-report-repository.ts` (docs/rules.md §4) — `reset-sale.ts` körde tidigare
`BEGIN`/`COMMIT` via `Pool.query()` direkt, vilket INTE garanterar samma anslutning och
alltså inte var en riktig transaktion; nu `pool.connect()` + en `PoolClient`.

**realtime-gateway: en delad Redis-prenumeration per podd** (Fas 3-reviewns notering
löst): `shared/redis/src/pubsub.ts`s `subscribeToChannelPrefix` (`PSUBSCRIBE ws:*`) +
`services/realtime-gateway/src/services/ws-subscriber-registry.ts` (lokal
kanal→handler-tabell) ersätter en duplicerad Redis-anslutning per WS-klient. Både
pubsub.ts och registryt har nu try/catch runt varje meddelande/handler — en delad
anslutning gör annars ETT trasigt meddelande till en krasch för ALLA klienter på podden,
inte bara en (hittat i reviewn). `ws.ts` (route) splittrad i en tunn route +
`controllers/ws-controller.ts` — `eslint-plugin-boundaries` tillåter inte routes → att
importera services-layer direkt.

**Köinsläpp: döda sessioner slösar inte längre kvoten** (andra Fas 3-reviewns notering
löst): `admitNextBatch` (`shared/redis/src/waiting-room.ts`) tar nu en 5:e parameter
(`sessionTotalMinutes`) och jämför ZSET:ets ankomsttid mot den innan en poppad post
markeras insläppt — en redan utgången session hoppas över och loopen fortsätter popppa
efter fler levande poster i samma tick. `queue-config-repository.ts` (scheduler-worker)
läser åter `queue_session_total_minutes` (en tidigare medveten uteslutning, nu
reverserad av just detta skäl).

**Ny kategori/sök-funktion på events** (inte bara styling, uttryckligen efterfrågat):
migration `1700000013000_add-events-category.ts` lägger till `events.category`
(`music`/`sports`/`theatre`/`festival`, NOT NULL DEFAULT 'music', indexerad).
`GET /events?category=&q=` — `shared/schemas/src/events-query.ts` (ny Zod-schema),
scatter-gather över båda shards i `events-repository.ts`/`events-service.ts` (samma
`Promise.allSettled`-mönster som `my-tickets-service.ts`). `q` matchar titel/artist via
`ILIKE`.

**Frontend: Tailwind v4, men UTAN Preflight** (`apps/web/src/styles/globals.css`
importerar `tailwindcss/theme.css` + `tailwindcss/utilities.css`, INTE det samlade
`'tailwindcss'`-importet) — upptäckt i reviewn: Preflight hade nollställt
webbläsarstandarden för rubriker/knappar/listor på EventPage/SeatmapPage/
ReservationPage/MyTicketsPage, som Fas 6 INTE byggde om, och gjort just
bokningsflödet (det som visas på försvaret) visuellt trasigt. Ny startsida
(`routes/HomePage.tsx`, ersätter `EventsListPage.tsx`) + `components/{Navbar,EventCard}.tsx`
— kategori/sök-filter lever i URL:ens query-sträng (`useSearchParams`), inte lokalt
state, så en delad länk återskapar vyn. `lib/categories.ts` har en `isEventCategory`-
typguard (inte en `as`-kastning, docs/rules.md §2).

**`services/scheduler-worker/src/scripts/seed-demo-events.ts`** seedar 5 extra
demo-event (en delad liten arenageometri, 30 platser) över alla fyra kategorier, för att
startsidan inte ska vara tom. Skriver bara till DEN shard ett event faktiskt hashar till
(`getPoolForEvent`) — till skillnad från `tests/e2e/seed.ts`, som ofarligt kan duplicera
sin fixture på båda shards eftersom den bara läser ETT känt event-id; `listAllEvents`
gör en RIKTIG scatter-gather-sammanslagning, så en dubblett hade synts två gånger.

**Realtime-gateway-ingressen var redan löst sedan Fas 3** — Fas 5-reviewns notering om
en "saknad ingress" var ett falskt larm: `infra/k8s/base/booking-api/ingress.yaml`
routar redan `/ws` till `realtime-gateway` på samma host (`api.tikknet.se`). Rättat i
både `docs/plan.md` och `.github/workflows/deploy.yml`:s kommentarer.

**Rate limiter-allowlist för lastgeneratorer:** `RATE_LIMIT_ALLOWLISTED_IPS`
(booking-api, tom som default) — se docs/runbook.md "Lasttest: allowlista
generatorernas IP:n i rate limitern" för kommandot (`kubectl set env`, ta bort efteråt).

**PodDisruptionBudget på scheduler-worker/payment-mock** (`maxUnavailable: 1`) är
medvetet overksam idag (en enda podd) — motivering i docs/forsvar.md "Varför en
PodDisruptionBudget på en tjänst som bara har EN podd?".

## Läget efter Fas 5

**CORS saknades helt i booking-api** fram till Fas 5-reviewn — appen och API:et är
alltid olika origin (`<domän>` vs `api.<domän>`), så webbläsaren hade blockerat varje
svar. `routes/cors.ts` registrerar `@fastify/cors` med en explicit allowlist från
`CORS_ALLOWED_ORIGINS` (kommaseparerad, aldrig wildcard — systemet använder aldrig
cookies, se docs/rules.md §6). Satt till `https://tikknet.se` i
`infra/k8s/base/booking-api/deployment.yaml` och `http://localhost:5173` som default
annars (lokal dev/e2e).

**`eslint-plugin-boundaries`-gapet är löst.** Upptäckt under Fas 5-reviewn (orsakad
inte av den — fanns sedan `boundaries/root-path` infördes): utan en ABSOLUT sökväg
defaultar den till `process.cwd()` vid lint-tillfället, och `turbo run lint` kör varje
paket-`eslint .` i sin EGEN katalog, så `services/*/src/controllers/**` m.fl. matchade
aldrig. Fixat med `'boundaries/root-path': import.meta.dirname` i `eslint.config.js`.
`scripts/verify-boundaries-enforcement.mjs` testar nu BÅDA cwd-fallen (repo-rot och
paketkatalog) så regressionen inte kan smyga tillbaka obemärkt.

**Nytt etablerat mönster: `Promise.allSettled` för scatter-gather-läsningar över båda
shardarna** (`events-service.ts`s `listAllEvents`, `my-tickets-service.ts`s
`listMyTickets`) — en nedgången shard ger ett partiellt resultat + en loggad varning,
aldrig ett 500 för allt. Följ samma mönster om fler scatter-gather-endpoints byggs.

**Seatmap-statuscachen (`seatmap-service.ts`) failar ÖPPET mot Redis** (läs OCH skriv),
samma princip som `queue-auth-service.ts`s revokeringskoll — en Redis-hicka faller
tillbaka till Postgres istället för att 500:a hela 2-sekunderspollningen.

**"Din stol togs" är nu kopplat ände-till-ände** (det kvarvarande Fas 3-gapet): markera/
avmarkera (`POST`/`DELETE /events/:eventId/seats/:seatId/mark`, bakom insläppt kötoken,
max 5 markeringar), ett omvänt Redis-index (`seatmark-holders:<event>:<seat>`,
`shared/redis/src/seat-marks.ts`) så `notifySeatsTaken` (anropas från
`reservations-controller.ts` efter en lyckad reservation) vet vilka kötoken som ska
notifieras, och frontend lyssnar via WS (`hooks/use-seat-marking.ts`) och avmarkerar +
visar ett meddelande. Best-effort hela vägen — kan aldrig fälla reservationssvaret.

**PWA-deploy och full e2e är nu byggda också** (efter en uppföljande runda samma
dag): `deploy-frontend`-jobbet laddar upp `apps/web`s build till R2 (delar medvetet
bucket med backuperna — se docs/plan.md "kända luckor"), och
`tests/e2e/specs/booking-flow.spec.ts` går hela vägen genom en RIKTIG Auth0-inloggning
(nytt testkonto, se docs/runbook.md) och en betalning mot payment-mock till en synlig
biljett. **Overifierat mot en riktig Auth0-tenant** — automatiseringen av Auth0:s
hostade inloggningssida är skriven mot deras dokumenterade standardfält men har
aldrig körts mot en riktig tenant. Första riktiga CI-körningen är det verkliga testet;
felar den, börja med `tests/e2e/specs/booking-flow.spec.ts`s `loginWithTestUser`.
Ny lucka hittad i samma arbete: `realtime-gateway` saknar fortfarande ingress — se
docs/plan.md "kända luckor".

## Läget efter Fas 4

**Oversold-stol-beslutet är löst:** en stol som förlorar `tickets_valid_seat_unique`-
racet i `mintTicketsForSeats` (`services/booking-api/src/services/payment-consumer-
service.ts`) släpps (`releaseConflictedSeat`) och återbetalas individuellt via
`payment-refund-service.ts`s `refundSeatsAndNotify` (ny outbox-händelse
`order.seat_refunded`, egen e-postmall i notification-worker) — resten av ordern
bekräftas som vanligt. Om samtliga stolar i en order krockar faller det tillbaka till
en full återbetalning. `payment-refund-service.ts` finns som egen fil enbart för att
hålla `payment-consumer-service.ts` under docs/rules.md §8:s 300-radersgräns.

**Infrastruktur byggd men inte applicerad mot ett riktigt kluster** (ingen
Tailscale-åtkomst i byggmiljön): `infra/terraform/observability.tf` (kube-prometheus-
stack 92.11.0, Loki 19.0.3 (grafana-community-repot, inte det gamla grafana/loki),
Alloy 1.14.2), `infra/terraform/alloy-config.alloy` (validerad med
`alloy validate --stability.level=experimental` i Docker — inte mot ett kluster),
`infra/k8s/base/monitoring/` + `infra/k8s/base/backup/`. Manuella engångssteg som
krävs innan `terraform apply` kan lyckas: R2-bucket + token (`docs/runbook.md`
"Backup-lagring: Cloudflare R2"), ny Auth0-app för Grafana (`docs/runbook.md`
"Grafana-inloggning via Auth0"), Slack-webhook. `terraform.tfvars` behöver
`grafana_auth0_domain`/`_client_id`/`_client_secret`, env-var
`TF_VAR_slack_webhook_url`. GitHub repo-secrets: `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET` (deploy.yml skapar
`backup-r2-credentials` i `data`-namnrymden från dem).

**Namnrymds-ägarskap (viktigt att inte blanda ihop i senare faser):** Terraform äger
`observability` (kube-prometheus-stack/Loki/Alloy/Grafana). Kustomize/deploy.yml äger
`ticketing` och `data`, inklusive `infra/k8s/base/monitoring/*` (ServiceMonitors,
PrometheusRule, dashboard-ConfigMaps) och `infra/k8s/base/backup/cronjob.yaml` — de
ändras med appen, inte med klustret, trots att de refererar Prometheus Operators CRD:er.
`kube-prometheus-stack` är konfigurerad med `serviceMonitorSelectorNilUsesHelmValues:
false` (m.fl.) så den plockar upp ServiceMonitors i alla namnrymder, inte bara sin egen.

**Restore-övningen är inte genomförd** — skript finns i `docs/runbook.md`
"Återställning av databas", men RPO/RTO-tabellen där är tom. Måste köras mot ett
riktigt kluster och tiderna skrivas in innan Fas 7 (`architecture.md`/`runbook.md`
med RPO/RTO).

**Cache-hit-ratio vid kanten** (docs/plan.md "Realtid") är fortfarande inte uppmätt/
inskriven — ett kvarstående Fas 1-gap, inte löst av Fas 4.

**Rättat: `reservation-idempotency.test.ts`s skenbara flakighet** (sågs i CI
2026-10-25, två separata körningar, med `fulfilled.length` 2 respektive 4 istället
för det hårdkodade 1). Grundorsaken var INTE en race i
`idempotency-repository.ts` — den koden är korrekt — utan ett för strikt
test-antagande: `Promise.allSettled` garanterar inte att alla 10 parallella
anropen hinner köra sin första DB-fråga innan den snabbaste av dem redan hunnit
slutföra HELA operationen (claim → lås säte → skapa reservation → markera
`completed`). Under en belastad CI-runner hinner fler av de 10 anropen se
`status: completed` (en korrekt idempotent repris) istället för `in_flight`,
vilket ger fler än ett `fulfilled`-utfall utan att den faktiska garantin
(ingen dubbelbokning) bryts. Testet kontrollerar nu detta direkt — att alla
`fulfilled`-utfall pekar på SAMMA `reservationId` och att exakt en
reservations-rad skapas — istället för en exakt 1-lyckad/9-409-uppdelning.
`docs/phase-status.md` på `feature/fas5` har en äldre, numera inaktuell
anteckning som beskriver detta som "odiagnostiserad flaky" — bör tas bort när
den branchen uppdateras.

**Affärsmått saknas fortfarande:** bara RED (http_requests_total/duration),
`oversell_prevented_total` och `rabbitmq_queue_messages_ready` (riktiga pluginet, inte
den borttagna egna gaugen) existerar som Prometheus-mått. "Aktiva reservationer",
"insläppstakt", "sålda biljetter", "konverteringsgrad" (docs/plan.md "Vad som mäts")
har ingen egen counter/gauge byggd ännu — dashboards i Fas 4 (`infra/k8s/base/
monitoring/dashboards.yaml`) bygger bara på det som faktiskt finns.

**OTel-instrumentering** finns i alla fem tjänster (`shared/observability/src/
tracing.ts`, preloadas via `node --import ./dist/instrumentation.js` — se Dockerfile/
package.json/tsup.base.ts i varje tjänst). Alloy tar emot spans på OTLP men exporterar
dem bara till `otelcol.exporter.debug` (loggas, visas ingenstans) tills Tempo kopplas
in efter VG — `alloy.stabilityLevel: experimental` i Helm-values är satt enbart för
den placeholdern och bör sänkas till default när den byts mot en riktig
Tempo-exportör.
