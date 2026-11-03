# Arkitektur

Översikt över hur systemet hänger ihop. Detaljerna och motiveringarna finns i
[plan.md](./plan.md), [forsvar.md](./forsvar.md) och ADR:erna i [adr/](./adr/). Diagrammen är
Mermaid-block som GitHub ritar upp. Klustret (noder, namnrymder, poddar) ritas separat i
[cluster.md](./cluster.md).

## Hela systemet

Pilarnas form visar hur delarna pratar: heldragen pil = HTTP(S), tjock pil = WebSocket, streckad pil =
RabbitMQ (AMQP) eller Redis pub/sub. Postgres är sanningen, Redis är snabb hjälp som får gå förlorad.

```mermaid
flowchart LR
  subgraph Klienter
    WEB["Webbapp (React PWA)<br/>tikknet.se"]
    SCAN["Scanner (React-webbapp)<br/>scan.tikknet.se<br/>(Worker ej applicerad)"]
  end

  subgraph CF["Cloudflare"]
    EDGE["Proxy: DNS, TLS, DDoS<br/>api.tikknet.se"]
    WK["Workers + R2<br/>statiska filer, /ingest"]
    TS["Turnstile"]
  end

  subgraph EXT["Externa tjänster"]
    A0["Auth0<br/>inloggning, JWT"]
    ST["Stripe<br/>Checkout"]
    PH["PostHog EU"]
  end

  subgraph K8S["k3s-kluster på Hetzner"]
    ING["ingress-nginx"]
    BA["booking-api<br/>HTTP-API + konsument"]
    RG["realtime-gateway<br/>WebSocket"]
    SW["scheduler-worker<br/>insläpp, frisläpp,<br/>outbox-relay, mått"]
    NW["notification-worker<br/>mejl (simulerade)"]
    PM["payment-mock<br/>bara lasttest"]
    PG[("Postgres shard-0 + shard-1<br/>md5(event_id) % 2")]
    RE[("Redis<br/>kö, rate limit, cache,<br/>pub/sub ws:*")]
    MQ{{"RabbitMQ<br/>exchange domain-events"}}
  end

  WEB -->|"HTTPS: hämta appen"| WK
  SCAN -->|"HTTPS: hämta appen"| WK
  WEB -->|"HTTP: events, kö, karta,<br/>reservation, checkout, biljetter"| EDGE
  SCAN -->|"HTTP: POST /scans"| EDGE
  WEB ==>|"WebSocket: admitted,<br/>sales_closed, seat_taken"| EDGE
  WEB -->|"OIDC-inloggning"| A0
  SCAN -->|"OIDC-inloggning (staff)"| A0
  WEB -->|"Turnstile-widget"| TS
  WEB -->|"betala"| ST
  WK -->|"/ingest proxy"| PH

  EDGE --> ING
  ING -->|"HTTP"| BA
  ING ==>|"WebSocket"| RG

  BA -->|"SQL: lås platser,<br/>outbox i samma transaktion"| PG
  BA -->|"kö-Lua, rate limit, cache"| RE
  BA -.->|"pub/sub: seat_taken"| RE
  BA -->|"HTTP: skapa session, refund"| ST
  ST -->|"HTTP: webhook<br/>checkout.session.completed"| BA
  BA -->|"JWKS: verifiera JWT"| A0
  BA -->|"verifiera Turnstile-svar"| TS
  BA -->|"serverhändelser"| PH

  SW -->|"SQL: utgångna reservationer,<br/>läs outbox (SKIP LOCKED)"| PG
  SW -->|"släpp in ur ZSET"| RE
  SW -.->|"pub/sub: admitted, sales_closed, sold_out"| RE
  RE -.->|"psubscribe ws:*"| RG

  SW -.->|"AMQP publish: reservation.created,<br/>payment.succeeded, order.confirmed,<br/>order.refunded, order.seat_refunded"| MQ
  MQ -.->|"payment.succeeded<br/>kö booking-api.payment-succeeded"| BA
  MQ -.->|"order.*<br/>kö notification-worker.order-events"| NW
  NW -->|"dedupe-nyckel"| RE
  PM -.->|"webhook i lasttest<br/>(i stället för Stripe)"| BA
```

Händelserna och vem som tar emot dem:

| Event | Skrivs i outbox av | Konsumeras av |
|---|---|---|
| `reservation.created` | booking-api, vid reservation | ingen (publiceras, ingen kö binder den) |
| `payment.succeeded` | booking-api, i Stripe-webhooken | booking-api: biljetter, order `paid`, ev. återbetalning |
| `order.confirmed` | booking-api, när biljetterna skapats | notification-worker: bekräftelsemejl |
| `order.refunded` | booking-api, vid hel återbetalning | notification-worker: återbetalningsmejl |
| `order.seat_refunded` | booking-api, vid återbetalning av enstaka platser | notification-worker |

Varje kö har leveransgräns 5 och en dödkö `<kö>.dead` via `tickets.dlx`. WebSocket-meddelandena
(`admitted`, `sales_closed`, `sold_out`, `seat_taken`) är fire-and-forget: allt kan också läsas via
HTTP. Webbappen lyssnar i dag bara på `seat_taken` över WebSocket; kösidan pollar `GET /queue/status`
var 2:a sekund.

## Från webbläsare till databas

En request går genom Cloudflare, direkt till en nods ingress-nginx (DNS round-robin mellan
noderna, ingen extern lastbalanserare, [ADR-0007](./adr/0007-dns-round-robin-without-lb.md)) och
vidare till en `booking-api`-podd. ingress-nginx och Servicen lastbalanserar över minst två poddar. Routinglagret hashar `event_id` och väljer shard
([ADR-0008](./adr/0008-sharding-per-event.md)). Postgres är sanningen: Redis avgör aldrig om en stol
får reserveras.

```mermaid
flowchart LR
  B[Webbläsare<br/>tikknet.se] -->|HTTPS| CF[Cloudflare<br/>TLS, CDN]
  CF -->|A-poster mot noderna| IN[ingress-nginx<br/>DaemonSet]
  IN --> SVC[Service<br/>booking-api]
  SVC --> API[booking-api-podd<br/>controller → service → repository]
  API --> R{shard-router<br/>hash event_id}
  R --> P0[(Postgres shard-0<br/>+ globala tabeller)]
  R --> P1[(Postgres shard-1)]
  API -.->|kö, rate limit,<br/>stolsstatus-cache| RE[(Redis)]
  B -.->|statiska filer| CDN[R2 via Worker<br/>tikknet.se, cdn., scan.]
```

Statiska filer (webbappen, scannern, eventbilder, loggor) ligger i en R2-bucket och serveras av
Cloudflare Workers med en vitlista över prefixen, eftersom samma bucket även håller databas-backuperna.

## Köp: från väntrum till biljett

Kön och reservationen är anonyma (kötoken); inloggning krävs först vid betalning. Efter betalningen går
allt asynkront via transaktionell outbox, så en krasch mellan databasen och RabbitMQ aldrig tappar en
händelse.

```mermaid
sequenceDiagram
  participant W as Webbapp
  participant A as booking-api
  participant D as Postgres
  participant S as scheduler-worker
  participant R as Redis
  participant P as payment-mock / Stripe
  participant M as RabbitMQ
  participant N as notification-worker
  W->>A: join queue
  S->>R: släpper in i takt
  W->>A: reservera stolar (max 5)
  A->>D: lås varje stol (FOR UPDATE NOWAIT, sorterade id)
  A-->>W: reservation, 5 min
  W->>A: checkout (Auth0)
  A->>P: skapa session
  P-->>A: webhook (signerad)
  A->>D: outbox-rad
  S->>M: outbox-relay publicerar
  M->>A: payment.succeeded
  A->>D: biljetter + order paid + outbox order.confirmed (en transaktion)
  S->>M: outbox-relay publicerar order.confirmed
  M->>N: order.confirmed → e-post med QR
  W->>A: pollar order tills paid
```

Realtid: `realtime-gateway` håller WebSocket-anslutningar och prenumererar på Redis `ws:*`
(köposition, "din stol togs"). `scheduler-worker` är exakt en podd (`Recreate`) och äger insläpp,
frisläpp av utgångna reservationer och outbox-relayen.

## Från merge till produktion

En merge till `main` startar hela kedjan. Migrations körs som ett eget Job med advisory lock mot båda
shardarna, före koden, och måste därför alltid vara framåtkompatibla. Pipelinen avbryts om något steg
misslyckas.

```mermaid
flowchart LR
  M[Merge till main] --> CI[lint, typecheck,<br/>enhet, integration,<br/>Pact, e2e, system]
  CI --> IMG[bygg 6 images parallellt<br/>push till GHCR]
  IMG --> MIG[migrations-Job<br/>båda shardarna]
  MIG --> APPLY[kubectl apply<br/>kustomize-overlay]
  APPLY --> ROLL[rullande uppdatering<br/>maxUnavailable 0]
  ROLL --> VERIFY[rollout status]
  CI --> FE[deploy-frontend:<br/>bygg webb + scanner,<br/>rclone till R2]
```

Zero-downtime kräver fyra saker samtidigt: `readinessProbe`, `maxUnavailable: 0`, `preStop` med
`terminationGracePeriodSeconds`, och graceful shutdown i appen. Beviset ligger i
[evidence/zero-downtime.md](./evidence/zero-downtime.md): 0 misslyckade av 22 978 requests under två
rolloutar.

## Observability, skalning och drift

```mermaid
flowchart TB
  subgraph ticketing
    BA[booking-api<br/>HPA 2–10]
    RG[realtime-gateway<br/>HPA 2–4]
    SW[scheduler-worker<br/>1]
    NW[notification-worker<br/>KEDA 1–10]
  end
  subgraph observability
    PR[Prometheus] --> GR[Grafana]
    AL[Alloy] --> LO[Loki] --> GR
    AL -.-> TE["Tempo<br/>(byggt, ej applicerat)"] -.-> GR
    PR --> AM[Alertmanager] --> SL[Slack #tickets-alerts]
  end
  BA & RG & SW & NW -->|/metrics, Prometheus hämtar| PR
  BA & RG & SW & NW -->|loggar stdout| AL
  BA & RG & SW & NW -->|traces OTLP, 10 %| AL
  IN[ingress-nginx<br/>metrics] --> PR
  RQ[(RabbitMQ<br/>ködjup)] -->|trigger| NW
  CJ[Backup-CronJob<br/>pg_dump nattligen] --> R2[(R2)]
```

- Autoskalning: HPA på CPU för `booking-api` (mål 70 %, min 2, max 10), på minne för
  `realtime-gateway`, KEDA på ködjup för `notification-worker`.
- Mätning: RED-mått per tjänst, affärsmått (aktiva reservationer, insläppstakt, sålda biljetter) och
  ingress-mått. Dashboarden "Autoscaling & lasttest" visar repliker, last och zero-downtime-raden.
- Backup och återställning: nattlig `pg_dump` av båda shardarna till R2. RPO upp till 24 h; RTO mätt till
  cirka 3 s för hämtning och restore (plus några minuter manuellt arbete) i återställningsövningen (se [runbook.md](./runbook.md)).
- Produktanalys: PostHog EU via `/ingest`-proxyn ([ADR-0009](./adr/0009-posthog-eu-reverse-proxy.md)).
- Kontraktstester: Pact utan broker ([ADR-0011](./adr/0011-pact-without-broker.md)).

## Biljettscanner

Personal loggar in på `scan.tikknet.se` (Auth0, rollen `staff`), väljer event och grind och läser QR-koder
med mobilens kamera ([ADR-0010](./adr/0010-scanner-as-web-app.md)). Varje kod går till `POST /scans`, som
slår upp biljetten på `tickets.qr_token` inom eventets shard och registrerar skanningen i `ticket_scans`.
Det unika indexet på `(event_id, ticket_id)` gör att två samtidiga skanningar av samma biljett ger exakt
en `ok`.
