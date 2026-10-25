# Fasstatus mellan sessioner

Kort kontext nästa session behöver utöver `docs/plan.md` själv (docs/rules.md §11a).
Läs båda innan en ny fas påbörjas.

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
