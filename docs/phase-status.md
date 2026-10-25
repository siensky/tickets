# Fasstatus mellan sessioner

Kort kontext nästa session behöver utöver `docs/plan.md` själv (docs/rules.md §11a).
Läs båda innan en ny fas påbörjas.

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
