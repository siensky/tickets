# Biljettbokningssystem — byggplan

Byggplanen beskriver **vad** som ska byggas. Motiveringarna till varje vägval ligger i
[`forsvar.md`](./forsvar.md). Kodreglerna ligger i [`rules.md`](./rules.md).

---

## Context

Praktisk examination, Chas Academy. Solo-projekt (kräver lärarens godkännande — uppgiften
anger grupper om 2–3). Mål: VG **och** ett portfolioprojekt som stärker anställbarheten.

### Deadlines

| Datum | Vad |
|---|---|
| ~~fre 16/10~~ | Idé i gruppchatten — **passerad, stäm av med läraren** |
| **ons 4/11** | Muntligt försvar — systemet måste vara demo-klart |
| **sön 8/11** | Kodinlämning |

### G-krav

- Backend på egen VPS, `api.<domän>` över HTTPS
- Statiska filer på `cdn.<domän>`
- CI/CD: varje merge till main testas, byggs och deployas automatiskt
- Unit-, integrations- och e2e-tester i pipelinen
- Dagliga DB-backups till S3
- Metrics och logging

### VG-krav

- ≥2 backend-instanser bakom load balancer
- Deploy utan downtime — noll misslyckade requests
- Autoscaling som ökar **och** minskar med last, demonstrerat live

### Muntligt försvar

Individuella frågor, hela lösningen ska kunna förklaras: demo av app/pipeline/dashboard,
arkitektur (request→databas, merge→deploy), kod och tekniska val, drift och backups, samt
autoscaling och zero-downtime visat under load.

**Inlämning:** repolänk + README med adresser till api, cdn och dashboard.

---

## Domän och användarflöde

Biljettbokning med **platsval på interaktiv arenakarta**. 5 000 platser släpps under ett
15-minutersfönster, upp till 20 000 samtidiga besökare.

1. Välj evenemang → arenakarta med sektioner och enskilda stolar
2. Stolsstatus: **grön** ledig · **gul** reserverad av annan · **grå** såld · **blå** egen markering
3. Max 5 stolar per bokning, behöver inte ligga intill varandra
4. "Gå vidare" → **allt-eller-inget**-reservation i 5 minuter, nedräkning startar
5. Inloggning + betalning under reservationstiden → bekräftelse + e-post
6. Vid timeout frisläpps stolarna; väntelista erbjuds när allt är upptaget

---

## Tjänster

| Tjänst | Roll | Repliker |
|---|---|---|
| `booking-api` | Fastify HTTP-API, bokningstransaktionen | 2–10 (HPA) |
| `realtime-gateway` | WebSocket-server | 2–4 (HPA) |
| `scheduler-worker` | Insläpp i väntrum + frisläpp av utgångna reservationer | **exakt 1** |
| `notification-worker` | RabbitMQ-konsument: e-post, QR, push | 1–10 (KEDA på ködjup) |
| `payment-mock` | Simulerad betalleverantör med konfigurerbart kaos | 1 |
| `ai-service` | *Fas efter VG* — RAG + egen intent-klassificerare (Python) | 1 |

**Ingen backoffice/ops-panel byggs.**

---

## Concurrency-kärnan

**Postgres är sanningen.** Redis avgör aldrig om en stol får reserveras.

Reservation sker i **en transaktion**:

```sql
SELECT * FROM seats
WHERE id = ANY($1) AND event_id = $2
ORDER BY id
FOR UPDATE NOWAIT;
```

- **Allt-eller-inget** — hela reservationen rullas tillbaka om en enda stol är tagen
- **Lazy expiry** — utgången reservation frigörs också vid nästa reservationsförsök mot
  samma stol, utan att invänta `scheduler-worker`
- **Jittrat frisläpp** — innehavaren behåller exakt 5:00; frisläppandet sprids 0–20 s

---

## Väntrum

- Redis-baserad kö (ZSET). **Insläppstakt** (t.ex. 300/min) + **sessionstid**
  (15 min totalt, 10 min inaktivitet). Båda i `config`-tabellen, ändringsbara live
- Kötoken krävs för boknings-API:et, **valideras i API-lagret**
- **En aktiv reservation per kötoken**
- Ködjup = autoscaling-signal

---

## Realtid

| Data | Mekanism |
|---|---|
| Arenakartans **geometri** | API-endpoint med `Cache-Control: max-age=2592000`, cachad av Cloudflare |
| Stolarnas **status** | Polling var 2:a sekund mot Redis-cache, 1 s Cloudflare-cache vid kanten |

**WebSockets — endast ett-till-ett-fall:**

| Användning | Vad som skickas |
|---|---|
| Köplats | "Du är nummer 4 823", tickar nedåt live |
| Insläpp | "Nu är det din tur" |
| Reservationsnedräkning | Serverstyrd, så klienten inte kan fuska till sig extra tid |
| "Din stol togs" | Markerad stol tas av annan innan du hunnit reservera |
| AI-chatten *(senare fas)* | Strömmande svar |

WS-klienter återansluter automatiskt med exponentiell backoff.

---

## Redis — användningsområden

| Användning | Hur |
|---|---|
| Väntrumskön | ZSET med ankomsttid; köplats = rang i mängden |
| Kötokens | `token:<id>` med TTL = sessionstiden |
| Arenakartans statuscache | `seatmap:<event>:<sektion>` → JSON + versionsnummer |
| Rate limiting | `ratelimit:<ip>`, INCR + EXPIRE |
| Proof-of-work-utmaningar | Utfärdade utmaningar med TTL |
| Dedupe för notifikationer | Mängd av behandlade meddelande-id med TTL |
| Config-cache | Värdena från `config`-tabellen |
| **Pub/Sub mellan poddar** | Så `booking-api` kan nå en klient vars WS ligger på annan podd |

**Redis avgör aldrig om en stol får reserveras.**

---

## Botskydd — adaptiv eskalering

1. **Rate limiting per IP** (Redis, ~1 ms) — alltid på
2. **En aktiv reservation per kötoken** — alltid på
3. **Proof of work** vid tokenutfärdande (~200 ms klientsida) — alltid på
4. **Cloudflare Turnstile** — endast vid misstänkta signaler

PoW-svårigheten är konfigurerbar; sänks i lasttestläge.

---

## Auth

- **Inloggning krävs först vid betalning**, efter reservation. OAuth2 via Auth0 gratisnivå
- Reservationen binds till **kötoken**, inte till inloggning
- **M2M:** NetworkPolicies som baslager + **OAuth2 client credentials för scanner-appen**
- **HMAC-signerad webhook** från betaltjänsten
- Lasttest använder förutfärdade tokens

---

## Betalning

- **Stripe testläge** för det riktiga flödet (Checkout + webhooks).
  Kortuppgifter når aldrig backend
- **`payment-mock`** för lasttest, med konfigurerbart kaos: slumpmässig latens, ~5 % fel,
  **dubbla webhooks**, svar som anländer efter att reservationen löpt ut

---

## Idempotens

- Idempotensnyckel på **reservation** och **betalning** (unique-index, sparat svar)
- Webhook-dedupe på leverantörens händelse-id
- **Transactional outbox + relay** — meddelandet skrivs i samma transaktion som ordern

**Konsument-dedupe, nivåindelat efter konsekvens:**

| Typ | Mekanism |
|---|---|
| Pengar och biljetter | `processed_messages`-tabell med unique-constraint |
| Notifikationer | Redis-set med TTL |
| Där möjligt | Naturligt idempotent (QR från deterministisk hash av `order_id`+`seat_id`) |

---

## Databas

**Två Postgres-poddar i samma kluster.** Shard-nyckel `event_id`. Routinglager hashar,
migrations mot båda, backup av båda, per-shard-paneler i Grafana.

**Globala tabeller (`users`, `faq_documents`, `config`) ligger på shard-0.**
`orders.user_id` är en UUID **utan främmande nyckel**. "Mina ordrar" via **scatter-gather**.

**Regel:** varje shardad tabell bär `event_id`, även när värdet går att härleda.

### Globala tabeller (shard-0)

```
users             id, auth0_sub, email, name, created_at
venues            id, name, city
venue_sections    id, venue_id, name, display_order
venue_seats       id, venue_id, section_id, row, number, x, y
faq_documents     (AI-fasen)
config            key, value
```

### Shardade tabeller

```
events             id, venue_id, title, artist, starts_at,
                   sales_open_at, sales_close_at, status

seats              id, event_id, venue_seat_id, section_id, row, number,
                   price_cents, status, reservation_id, updated_at
                   UNIQUE (event_id, section_id, row, number)

reservations       id, event_id, queue_token_id, status,
                   expires_at, release_after, created_at

orders             id, event_id, user_id, reservation_id,
                   total_cents, status, created_at

payments           id, event_id, order_id, provider, provider_ref,
                   idempotency_key, amount_cents, status, raw_response

tickets            id, event_id, order_id, seat_id, qr_token,
                   scanned_at, scanned_by
                   UNIQUE (event_id, seat_id)

idempotency_keys   key, scope, request_hash, response_body, status, expires_at
processed_messages message_id, consumer, processed_at
outbox             id, event_id, type, payload, created_at, published_at
waitlist           id, event_id, contact, created_at
```

- `seats.status` är en **lagrad kolumn**, uppdaterad i samma transaktion som låser stolen
- **Retention:** `reservations` rensas efter **30 dagar** (nattligt jobb i `scheduler-worker`)
- `config` styr: insläppstakt, reservationstid, jitter-fönster, max stolar/bokning,
  PoW-svårighet

---

## Repo- och filstruktur

```
tickets/
├── shared/
│   ├── auth/                   JWT-verifiering, kötoken, scopes
│   ├── db/                     shard-router, migrations, anslutningspooler
│   ├── rabbit/                 anslutning, publicering, konsumentbas
│   ├── redis/                  klient, nyckelkonventioner, Lua-skript
│   ├── domain/                 affärsregler som FLERA tjänster behöver + errors.ts
│   ├── observability/          logger, metrics, tracing
│   ├── schemas/                Zod-scheman (delas med frontend)
│   ├── analytics/              typade PostHog-händelser + server-SDK
│   └── types/
├── services/                   identisk intern struktur per tjänst
│   ├── booking-api/
│   │   ├── src/
│   │   │   ├── routes/ controllers/ services/ repositories/
│   │   │   ├── mappers/ schemas/ types/
│   │   │   └── index.ts        ingångsfil med start()
│   │   └── tests/
│   ├── realtime-gateway/
│   ├── scheduler-worker/
│   ├── notification-worker/
│   └── payment-mock/
├── apps/
│   ├── web/                    React PWA — kundappen
│   └── scanner/                Expo — dörrvärdens biljettscanner
├── infra/
│   ├── terraform/
│   └── k8s/                    Kustomize: bas + overlays
├── tests/
│   ├── e2e/                    Playwright
│   └── load/                   k6
└── docs/
    ├── plan.md                 denna fil
    ├── forsvar.md              motiveringar inför muntligt försvar
    ├── rules.md                kodregler
    ├── architecture.md
    ├── adr/                    numrerade arkitekturbeslut
    └── runbook.md              vad man gör när något går fel
```

---

## Stack

Node.js · Fastify · TypeScript · pnpm workspaces · Turborepo · Vitest · tsx · Zod ·
Postgres · Redis · RabbitMQ · React + Vite (PWA) · TanStack Query · Expo · Playwright · k6

---

## Tester

- **Integrationstester via Testcontainers** (riktiga Postgres/Redis/RabbitMQ-containrar)
- **Pipeline vid varje merge till main:** lint, typecheck, enhetstester,
  integrationstester, e2e. Lasttester körs separat
- **Täckning:** 90 % på `shared/domain` och `shared/db`. Ingen tröskel på limkod, men
  **varje route måste ha minst ett lyckat och ett misslyckat fall**

### Fyra tester som bevisar systemet

1. **Kapplöpning** — 100 parallella försök på samma stol → exakt 1 lyckas, 99 rena felsvar
2. **Deadlock** — `[5,9]` och `[9,5]` samtidigt → båda slutförs, ingen deadlock
3. **Idempotens** — samma nyckel 10× parallellt → en betalning, en order
4. **Outbox** — RabbitMQ nere under köp → meddelandet levereras när den återkommer

Plus **ett stort e2e-test av hela flödet**: väntrum → karta → reservation → betalning →
bekräftelse → QR-skanning.

---

## Infrastruktur

- **Hetzner Cloud + Terraform + k3s**
- **Kostnadsstrategi:** 2× CX22 (~90 kr/mån) under utveckling. Skala upp till 3–4 noder
  via Terraform-variabel endast under lasttest och demo (~1 kr för 6 timmar)
- Mesta utvecklingen sker lokalt med docker-compose
- **Load balancer:** ingress-nginx i klustret
- **Gratis lager:** Cloudflare (DNS + CDN), Cloudflare R2 eller Backblaze B2 (backups),
  GHCR (registry), GitHub Actions (CI), PostHog cloud, Auth0

### Terraform

- **Äger:** Hetzner-servrar, brandvägg, privat nätverk, Cloudflare DNS, objektlagring,
  samt klusterkomponenter som sällan ändras (ingress-nginx, cert-manager, KEDA,
  kube-prometheus-stack)
- **Äger inte:** applikationens manifest — de deployas vid varje merge
- **State: lokal statefil, `.gitignore`:ad.** Innehåller hemligheter i klartext och får
  aldrig committas till det publika repot. Säkerhetskopieras manuellt utanför repot

### Kubernetes — noder

| Läge | Noder | Totalt |
|---|---|---|
| Utveckling | 2× CX22 (2 vCPU, 4 GB) | 4 vCPU, 8 GB |
| Lasttest och demo | + 2× CX32 (4 vCPU, 8 GB) | 12 vCPU, 24 GB |

**Namespaces:** `ticketing` · `data` · `observability` · `ingress-nginx` · `keda` · `cert-manager`

### Kubernetes — arbetslaster

| Workload | Typ | Vila | Topp | CPU req/limit | Minne req/limit |
|---|---|---|---|---|---|
| booking-api | Deployment | 2 | **10** (HPA) | 100m / 500m | 128Mi / 256Mi |
| realtime-gateway | Deployment | 2 | 4 (HPA) | 100m / 500m | 256Mi / 512Mi |
| scheduler-worker | Deployment | **1** | **1** | 50m / 200m | 64Mi / 128Mi |
| notification-worker | Deployment | 1 | **10** (KEDA) | 50m / 300m | 64Mi / 128Mi |
| payment-mock | Deployment | 1 | 2 | 50m / 200m | 64Mi / 128Mi |
| postgres-shard-0 / -1 | StatefulSet | 1 var | 1 var | 250m / 1000m | 512Mi / 1Gi |
| redis | StatefulSet | 1 | 1 | 100m / 500m | 256Mi / 512Mi |
| rabbitmq | StatefulSet | 1 | 1 | 100m / 500m | 256Mi / 512Mi |
| prometheus | StatefulSet | 1 | 1 | 100m / 500m | 512Mi / 1Gi |
| loki | StatefulSet | 1 | 1 | 100m / 300m | 256Mi / 512Mi |
| grafana | Deployment | 1 | 1 | 50m / 200m | 128Mi / 256Mi |
| ingress-nginx | DaemonSet | per nod | per nod | 100m / 500m | 128Mi / 256Mi |

I vila: ~1,5 vCPU och ~3,5 GB i requests. **PWA:n körs inte i klustret** — den byggs till
statiska filer på `cdn.<domän>`.

**Manifest:** Kustomize — bas per tjänst + overlays för staging och produktion.

### Zero-downtime — kräver alla fyra

1. `readinessProbe` på varje tjänst
2. `maxUnavailable: 0`
3. `preStop`-hook + `terminationGracePeriodSeconds`
4. Graceful shutdown i appen (SIGTERM → sluta ta emot, slutför pågående, stäng pooler)

Plus för WebSockets: klienterna återansluter automatiskt med exponentiell backoff.

### Probes

- `readinessProbe` → `/health/ready` — kontrollerar att Postgres och Redis går att nå
- `livenessProbe` → `/health/live` — kontrollerar **endast att processen lever**

### Autoscaling

- HPA på `booking-api`: mål 70 % CPU, min 2, max 10
- HPA på `realtime-gateway`: minnesbaserad, min 2, max 4
- **KEDA på `notification-worker`**: RabbitMQ-ködjup, 100 meddelanden/podd, min 1, max 10
- **`behavior.scaleDown.stabilizationWindowSeconds: 60`** (standard är 300)
- **Nodnivå:** Terraform-variabel `worker_count`; noder ansluter på ~2 minuter

**NetworkPolicies** mellan tjänster. **PodDisruptionBudget** `minAvailable: 1` per tjänst.

### Trafikväg

```
Webbläsare
  → Cloudflare (TLS, cache, Turnstile)
  → A-post mot nodens publika IP:443
  → ingress-nginx (DaemonSet på varje nod) — ruttar via värdnamn
  → Service (ClusterIP) — lastbalanserar över friska poddar
  → booking-api-podd
  → shard-router: hash(event_id)
  → Postgres-podd (shard-0 eller shard-1)
```

### Deploy

- **Fas 1: kubectl från GitHub Actions** — G-kravet grönt tidigt
- **Fas 2: ArgoCD (GitOps)** när resten står stabilt

### Secrets

- **Nu:** GitHub Actions secrets → Kubernetes Secrets vid deploy
- **Med ArgoCD:** migrera till Sealed Secrets

---

## Observability

**kube-prometheus-stack** installeras via Terraform. **Loki + Alloy** för loggar och traces.
**OpenTelemetry-instrumentering från dag ett** i `shared/observability`;
**Tempo kopplas in efter att VG-kraven är säkrade.**

**Prometheus hämtar (pull)** — varje tjänst exponerar `GET /metrics` via `prom-client`,
Prometheus skrapar var 15:e sekund. Poddar hittas via `ServiceMonitor`-resurser.

| Komponent | Hur metrics exponeras |
|---|---|
| booking-api, gateway, workers | `/metrics` direkt via `prom-client` |
| postgres-shard-0 / -1 | `postgres-exporter` som sidecar |
| redis | `redis-exporter` som sidecar |
| rabbitmq | Inbyggd Prometheus-plugin, aktiveras |
| Noderna (CPU, disk) | `node-exporter` som DaemonSet |
| Kubernetes-objekt | `kube-state-metrics` |

### Vad som mäts

- **Per endpoint (RED):** requesttakt, felfrekvens, svarstid p50/p95/p99
- **Affär:** aktiva reservationer, ködjup, insläppstakt, sålda biljetter, konverteringsgrad
- **Infrastruktur:** databasanslutningar **per shard**, låskonflikter, transaktionstid,
  RabbitMQ-ködjup, konsumenttakt, DLQ-storlek
- **`oversell_total`** — räknare som ökar om samma stol någonsin får två biljetter.
  Ska alltid vara noll; larm på `> 0`

**Larm:** Alertmanager → **Slack-webhook**. Ett larm triggas medvetet under demon.

**Grafana skyddas med OAuth-inloggning via Auth0** — adressen kan ligga i README som
uppgiften kräver, men bara behöriga kommer in.

---

## Backups

- Nattligt `pg_dump` av **båda** shardarna → R2/B2, 7 dagars rullande historik
- **Dokumenterad och faktiskt genomförd återställningsövning** i `runbook.md`, med
  tidtagning

---

## Klienter

**Två appar, inte tre.**

**`apps/web` — React PWA.** Kundappen. Körs i webbläsaren och kan *installeras*: ikon på
hemskärmen och helskärm på mobil, eget fönster och dock-ikon på desktop. En kodbas täcker
webb, mobil och desktop för kunder. Ingen Electron, ingen React Native här.

**`apps/scanner` — Expo (React Native).** Dörrvärdens app, för telefon. Native eftersom
den behöver kameran för QR-skanning och lokal lagring för offline-kön. Autentiserar via
OAuth2 client credentials. Postar skanningar över HTTP — behöver ingen WebSocket.

### Webbappens tekniska val

- **Arenakartan:** liten arena → alla platser visas direkt. Större arena → sektionsvy, och
  man klickar på en sektion för att se dess stolar. Minskar både rendering och polling-last
- **Serverdata: TanStack Query** — `refetchInterval`, cache, deduplicering, omförsök med
  backoff, och **pausad polling när fliken är dold**
- **Lokal data: Reacts `useState` + context** — inget extra state-bibliotek
- **Offline:** appskalet + **mina biljetter med QR-koder**. Bokning fungerar inte offline
  och ska visa det tydligt. **Inga push-notiser** i detta skede
- **PostHog:** funnel för hela bokningsflödet + session replay.
  Kritiska konverteringshändelser (`payment_succeeded`) skickas **serversidigt**
- **Deployment:** byggs i CI till statiska filer → R2/B2 → Cloudflare.
  Appen på `<domän>`, tillgångar på `cdn.<domän>`, API:et på `api.<domän>`

---

## Säkerhet

### Biljettinventariet

| Hot | Motåtgärd |
|---|---|
| Denial of inventory | En aktiv reservation per kötoken, PoW, rate limiting |
| Kökringgående | Kötoken signeras och valideras i API-lagret |
| Tokenhandel | Kort TTL, token bunden till session, engångsinsläpp |
| Massuppköp | Max 5 stolar/bokning + gräns per konto och per betalmetod |

### Betalningar

- **Prismanipulation** → servern beräknar alltid totalen från stolsraderna i databasen
- **Förfalskad webhook** → HMAC-verifiering + verifiering mot leverantörens API
- **Replay** → dedupe på händelse-id + tidsfönster
- **Betalning efter utgången reservation** → omvalideras **inuti** betalningstransaktionen
- **PCI DSS undviks helt** → Stripe Checkout; kortuppgifter når aldrig backend

### Auth och behörighet

- **IDOR** → varje fråga scopas på autentiserat user-id, aldrig enbart på resurs-id
- **JWT** → verifiera mot Auth0:s JWKS, lås algoritmen, kontrollera `aud`, `iss`, `exp`
- Tokens aldrig i URL:er — enbart i `Authorization`-headern
- **Mass assignment** → Zod strict mode; request-body sprids aldrig rakt in i en skrivning

### Applikationen

SQL injection → parameteriserad SQL · XSS → `dangerouslySetInnerHTML` förbjudet ·
CSRF → bearer-tokens i header istället för cookies · Prompt injection *(AI-fasen)* →
AI:ns verktyg scopas serversidigt till inloggad användare

### Infrastruktur

- Datatjänster: ClusterIP + brandvägg, ingen publik exponering
- **Endast port 443 öppen**, och bara från Cloudflares IP-intervall.
  SSH (22) och Kubernetes-API (6443) låsta till egen IP
- **gitleaks** som pre-commit-hook och i CI
- Containrar: `runAsNonRoot: true`, read-only rotfilsystem, droppade capabilities
- Lockfile committad, pinnade versioner

### GDPR

Känsliga fält **maskeras i session replay** · **cookie-samtycke krävs innan PostHog laddas** ·
IP-adresser anonymiseras i loggar · **raderingsendpoint** för en användares data ·
retentionspolicy (30 dagar) · **redaktionslista i loggern**

---

## Lasttest

**Generering:** 2–3 Hetzner-maskiner provisionerade med Terraform, körs några timmar och
rivs. Trafiken går via Cloudflare och ingress — hela den riktiga vägen.

**Lastgeneratorernas IP-adresser allowlistas i rate limitern** under testet, med
dokumenterad motivering. **PoW-svårighet sänks i huvudtestet**; ett separat litet test
körs med skarp svårighet och förberäknade lösningar.

| Scenario | Vad det gör |
|---|---|
| `smoke` | 10 VU — verifierar att hela flödet fungerar |
| `queue-storm` | 20 000 VU ansluter inom 60 s; mäter väntrummet |
| `booking-rush` | Insläppta användare reserverar och köper |
| `deploy-under-load` | `booking-rush` medan en ny version rullas ut |
| `shard-failure` | Shard-1 dödas mitt under lasten |

**Mätpunkter:** p50/p95/p99, felfrekvens, **`oversell_total` (måste vara 0)**, poddantal
över tid, ködjup, databasanslutningar per shard.

---

## Fasplan

Start 19/10. **Muntligt försvar 4/11** (dag 16). **Kodinlämning 8/11** (dag 20).

| Fas | Dagar | Datum | Innehåll | Mål |
|---|---|---|---|---|
| **0** | 1–2 | 19–20/10 | Repo, pnpm workspaces, Turborepo, TS, ESLint med `eslint-plugin-boundaries`, Prettier, gitleaks. `shared/domain/errors.ts`. docker-compose (2× Postgres, Redis, RabbitMQ). Domän + Cloudflare DNS. GHCR. | Grund |
| **1** | 3–5 | 21–23/10 | **Walking skeleton.** Terraform: 2 noder, brandvägg, privat nät. k3s, ingress-nginx, cert-manager/TLS. `booking-api` med bara health + metrics. Actions: lint → typecheck → test → image → `kubectl apply` → `rollout status`. | **G: automatisk deploy** |
| **2** | 6–9 | 24–27/10 | **Domänkärnan.** Schema + migrations mot båda shardarna. Shard-router. Reservationstransaktionen. Idempotensnycklar. Outbox + relay. `scheduler-worker`. **De fyra kronjuveltesterna.** | Projektets hjärta |
| **3** | 10–11 | 28–29/10 | Väntrum. `realtime-gateway` + Redis Pub/Sub. `notification-worker` + dedupe. `payment-mock` med kaos + HMAC. Auth0. Botskydd. | Flödet komplett |
| **4** | 12 | 30/10 | kube-prometheus-stack, Loki + Alloy, OTel-instrumentering. Dashboards, `oversell_total`, larm → Slack. Nattlig `pg_dump` → R2/B2 + **genomförd återställningsövning**. | **G: metrics, logging, backup** |
| **5** | 13–14 | 31/10–1/11 | PWA: evenemang, väntrum, arenakarta, reservation, checkout, mina biljetter. TanStack Query. Service worker + offline-biljetter. PostHog. Playwright e2e. | **G: e2e i pipeline** |
| **6** | 15 | 2/11 | HPA + KEDA (scaleDown 60 s). Zero-downtime: probes, `maxUnavailable: 0`, preStop, graceful shutdown. k6-scenarier. **Den stora körningen.** | **VG** |
| **7** | 16 | 3/11 | Repetition, demomanus, ADR:er, `runbook.md`. | Försvarsklar |
| — | — | **4/11** | **MUNTLIGT FÖRSVAR** | |
| **8** | 17–20 | 5–8/11 | Expo scanner-app. README med api/cdn/dashboard-adresser. `architecture.md`. Polering. | **Inlämning 8/11** |

**Om tiden tryter skärs i denna ordning:** scanner-appen (ej betygsgrundande) → PostHog →
session replay → offline-biljetter. Allt markerat **G** eller **VG** rörs sist.

**Efter inlämning (portfoliofaser):** ArgoCD + Sealed Secrets · Tempo-backend ·
AI-kundtjänst (RAG + egen intent-klassificerare) · DLQ · point-in-time recovery ·
hcloud cluster-autoscaler.

---

## Att ordna parallellt med fas 0

1. **Lärarens godkännande för soloprojekt** — idédeadlinen var 16/10
2. **Domän** — köp tidigt, DNS-propagering vill man inte vänta på i fas 1
3. **Konton** — Hetzner (kortverifiering kan ta en dag), Cloudflare, Auth0, PostHog,
   Slack-webhook. Kolla GitHub Student Developer Pack först

---

## Demomanus för det muntliga försvaret

1. **Appen:** välj evenemang → väntrum med live köplats → karta → välj stolar →
   reservation med nedräkning → betalning → bekräftelse → QR-kod
2. **En merge:** push till main → pipeline → tester → image → deploy → rollout
3. **Grafana:** RED-paneler, affärsmått, per-shard-vyer, `oversell_total` = 0
4. **Starta lasttestet:** 20 000 VU
5. **Under lasten:** poddar skalar 2 → 10; KEDA skalar workers på ködjup
6. **Under lasten: deploya en ny version** → visa noll misslyckade requests
7. Kön töms → poddarna skalar ner igen
8. **Döda shard-1 live** → evenemang på shard-0 fortsätter fungera
9. **Trigga ett larm** → visa att det landar i Slack
10. Visa återställningsövningen och dess tidtagning
