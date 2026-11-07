# Fas 6 — Autoscaling, zero-downtime och lasttest

**Status:** klar och mergad. **Utfall:** [`phase-status.md`](../phase-status.md) "Läget efter Fas 6", "Riktig lasttestkörning, första försöket (efter Fas 6)" och "CSV-biljettimport (egen liten gren, efter Fas 6)".

## Mål

**Klar efter review** (se nedan) — VG

## Omfattning

Planerat datum: 2–3/11.

HPA (**requests 250m**) + KEDA, `scaleDown` 60 s. Zero-downtime: probes, `maxUnavailable: 0`, preStop, graceful shutdown, **`Recreate` på scheduler-worker**. k6-scenarier, lastgeneratorer, fd-gränser. **Mät HPA-kurvan, sedan den stora körningen.** ~~**Notering från Fas 4-review:** `RabbitMQQueueDepthHigh`-larmets tröskel (900, `infra/k8s/base/monitoring/prometheusrule.yaml`) antar redan KEDAs planerade tak...~~ — **dubbelkollad**: `ScaledObject`:en (`infra/k8s/base/notification-worker/scaledobject.yaml`) är byggd med exakt 100 meddelanden/podd × max 10 poddar = 1000, så 900 stämmer fortfarande. ~~**Noteringar från Fas 3-review, innan `queue-storm`:** (1) `realtime-gateway` ger varje WS-klient sin egen duplicerade Redis-anslutning...~~ — **löst**: (1) EN delad `psubscribe ws:*`-anslutning per podd (`shared/redis/src/pubsub.ts`s `subscribeToChannelPrefix` + `services/realtime-gateway/src/services/ws-subscriber-registry.ts`), varje WS-anslutning registrerar sig lokalt (synkront, inget eget Redis-anrop) mot sin kötoken-id. (2) `admitNextBatch` (`shared/redis/src/waiting-room.ts`) hoppar nu över redan utgångna ZSET-poster (jämfört mot ankomsttid + `queue_session_total_minutes`) i stället för att markera dem insläppta, och fortsätter poppa efter fler levande poster i samma tick — scheduler-worker läser nu åter `queue_session_total_minutes` (queue-config-repository.ts). **Tillagt efter Fas 5-granskning, på uttrycklig begäran — INTE ett betygskrav, körs här ändå:** UI/styling-ombyggnad av PWA:n (hittills helt ostylad HTML, se "Fas 5 — kända luckor"). Ny startsida à la Ticketmaster — landningssida med utvalda konserter/evenemang + utfyllnadsinnehåll, mobile first. Navbar med kategorier (musik, sport, teater, festivaler), sökfält, inloggningsknapp. Bläddring per kategori, "köp biljetter"-knapp per evenemang leder in i det redan byggda bokningsflödet (Fas 5: väntrum → arenakarta → reservation → checkout). Färgschema röd/vit/svart + blå accent — proffsigt, "clean", dyr känsla, inte en lekstuga. **Inte bara styling:** kategori/sök kräver en ny `category`-kolumn på `events` (migration) och att `GET /events` stödjer filtrering — events är shard-partitionerat på sitt eget `id`, så en sökning över kategori blir scatter-gather över båda shards, samma princip som `GET /me/tickets` redan använder (`services/booking-api/src/services/my-tickets-service.ts`), inte en enkel `WHERE`-rad på en databas.

## Beroenden

Fas 5 klar.

## Berör

[`specification.md`](../specification.md): "Autoscaling", "Zero-downtime — kräver alla fyra", "Lasttest".

## Implementationssteg

Fasen planerades som raden i fastabellen ("Omfattning" ovan), utan numrerade steg.

## Kända luckor efter granskningen

**Fas 6 — kända luckor kvar efter reviewn** (flaggas hellre än göms, samma princip som
Fas 3/5):

- **Hela lasttest-infrastrukturen (Terraform, k6-scripten, rapport-/
  reset-skripten) är byggd men ALDRIG körd mot ett riktigt kluster** —
  samma gräns som Fas 4:s observability-infra (`infra/terraform/
  observability.tf` m.fl.), ingen Tailscale-åtkomst i byggmiljön, och
  ingen k6-binär fanns att testa mot ens lokalt. `tests/load/queue-storm.js`s
  WebSocket-anslutning (`k6/ws`) är särskilt overifierad — smoke-testa
  den specifikt med få VU innan en riktig körning.
- **HPA-kurvan** (docs/plan.md "Autoscaling": "Mät kurvan i Fas 6 före
  den stora körningen") är alltså heller inte uppmätt än — Grafana-
  panelen för den finns nu ("Autoscaling & lasttest"-dashboarden,
  `infra/k8s/base/monitoring/dashboards.yaml`, tillagd EFTER den
  initiala Fas 6-leveransen på uttrycklig begäran), men ingenting har
  faktiskt synts i den än.
- **De fyra affärsmåtten ("aktiva reservationer, insläppstakt, sålda
  biljetter, konverteringsgrad") finns nu i koden** (`shared/
  observability/src/metrics.ts`s `createBusinessMetrics`, se
  docs/phase-status.md) — löst samtidigt som Grafana-utbyggnaden, inte
  i den ursprungliga Fas 6-leveransen.
- **`queue_admission_rate_per_minute` måste höjas live** innan
  `normal-sale`/`spike-sale` körs på riktigt (se kommentaren i
  tests/load/normal-sale.js) — annars ackumuleras en obegränsad kö.
  Inget skript gör detta automatiskt; ett medvetet val (samma anda som
  reset-sale.ts: ingen automatisk körning av något som kan snedvrida
  nästa körning).
- **realtime-gatewayens minnesrequest (320Mi, upp från 256Mi) och
  HPA-tröskeln är en ouppmätt uppskattning** (deployment.yaml/hpa.yaml)
  — mät faktisk RSS i vila vid första riktiga deploy.
- **CSV-biljettimporten (se "Import av biljettnummer (CSV)" ovan) är nu
  byggd** — `services/scheduler-worker/src/scripts/import-tickets.ts`,
  byggd på en EGEN liten gren efter Fas 6, inte en del av den
  ursprungliga leveransen. Två antaganden som INTE ges av uppgiften
  (bekräftat med användaren att den riktiga filens format är okänt):
  (1) CSV:n antas vara EN kolumn (`ticket_number` per rad), utan
  sektion/rad/plats — paras ihop positionellt mot venuets befintliga
  `venue_seats` i en fixerad ordning. Anger den riktiga filen i stället
  sektion/rad/plats per biljettnummer måste ihopparningen bytas ut. (2)
  Inget skript seedar ännu den "riktiga" venuens 5 000 `venue_seats`
  själv (bara 30-sätes demo-venuen i seed-demo-events.ts) — det är ett
  separat, ännu obyggt steg före importen kan köras mot ett riktigt
  event.

## Acceptanskriterier

Inte formulerat som egna kriterier när fasen byggdes. Målet ovan och kraven i
[`specification.md`](../specification.md) "Kraven och var de uppfylls" gäller.
