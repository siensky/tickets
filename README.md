# tikknet

A ticket booking platform built to survive a sale: 5,000 seats go on sale in one 15-minute window
and up to 50,000 booking attempts hit the system, and no seat is ever sold twice. Customers pick
seats on an interactive venue map, hold them for five minutes, pay, and get a QR ticket. Door staff
scan the tickets on their phones.

This is my exam project at Chas Academy. It is a solo build, planned in [docs/plan.md](docs/plan.md)
(in Swedish) and deployed to a small Hetzner Cloud cluster.

## Live

|                              |                            |
| ---------------------------- | -------------------------- |
| Web app                      | https://tikknet.se         |
| API                          | https://api.tikknet.se     |
| Static files (images, brand) | https://cdn.tikknet.se     |
| Dashboards (Grafana, login)  | https://grafana.tikknet.se |
| Ticket scanner (staff only)  | https://scan.tikknet.se    |

## What it does

- **Waiting room.** Buyers get a place in a queue and are let in at a steady rate, so a spike turns
  into waiting instead of errors. If the queue is empty they walk straight in.
- **Seat map.** A venue overview, then a zoomable seat view with live updates ("someone took your seat").
  Works with the keyboard and on a phone.
- **All-or-nothing reservation.** Up to five seats, held for five minutes, in one database transaction.
- **Payment.** Stripe Checkout in test mode. The confirmation page only says "done" when the server
  says the order is paid, not when the browser returns.
- **Tickets.** QR codes under "My tickets", cached so they open without a connection. A staff-only scanner marks each ticket
  as used exactly once.

## Results

- **No oversold seats.** A partial unique index on `tickets (event_id, seat_id)` makes a double sale
  impossible at the database level. Both graded load tests (k6, about 50,000 booking attempts each, spread
  evenly over 15 minutes for `normal-sale` and in sharp spikes over 6.5 minutes for `spike-sale`) ended
  with no duplicate ticket numbers: `normal-sale` completed 539 purchases (2,695 tickets) and
  `spike-sale` 483 purchases (2,415 tickets). Most attempts end in a clean "seat already taken" (409) or
  wait in the queue, and the queue lets people in at a fixed rate, so not every seat sells within the window.
- **Zero-downtime deploys.** Two rolling restarts of `booking-api` under 10 booking attempts per second:
  0 failed requests out of 22,978, and no 5xx at the ingress
  ([evidence](docs/evidence/zero-downtime.md)).
- **Autoscaling.** `booking-api` scales from 2 to 5 pods during that run (HPA on CPU, max 10); the
  notification worker scales on RabbitMQ queue depth (KEDA).
- **Backups.** Nightly `pg_dump` of both shards to Cloudflare R2. In a restore drill the download and
  restore took about 3 seconds, plus a few minutes of manual steps (RPO up to 24 h, see
  [runbook](docs/runbook.md)).

## How it works

```
Browser → Cloudflare → ingress-nginx → booking-api → shard-router → Postgres shard 0 / 1
                                          ↘ Redis (queue, rate limit)   ↘ outbox → RabbitMQ → workers
```

- **Postgres is the source of truth.** Each seat is locked with `FOR UPDATE NOWAIT`, one at a
  time in sorted id order (a fixed lock order rules out deadlocks). Redis never decides whether a seat can be reserved.
- **Two shards, keyed by event.** One booking never crosses a shard.
- **Transactional outbox.** Payment events are written in the same transaction as the state change and
  relayed to RabbitMQ afterwards, so a crash cannot lose them.
- **Stack.** Node.js, TypeScript, Fastify, React + Vite (PWA), Postgres, Redis, RabbitMQ, Auth0, Stripe,
  Terraform, k3s, Prometheus/Grafana/Loki, k6, Playwright.

More detail: [architecture](docs/architecture.md) (diagrams), [decision records](docs/adr/), and
[forsvar.md](docs/forsvar.md) (the reasoning behind each choice, in Swedish).

## Run it locally

```bash
pnpm install
docker compose up -d                         # 2× Postgres, Redis, RabbitMQ
cp .env.example .env && set -a && . ./.env && set +a   # services read plain environment variables
pnpm --filter @tickets/db migrate            # both shards
pnpm --filter @tickets/scheduler-worker seed-events-from-csv   # 20 demo events
pnpm dev                                     # all services, the web app and the scanner
```

Fill in the empty values in `.env` first (Auth0, Stripe test keys, the queue and QR secrets). The web app
runs on http://localhost:5173 and the scanner on http://localhost:5174; their `VITE_*` settings go in
`apps/web/.env.local` and `apps/scanner/.env.local`. A single service:
`pnpm --filter @tickets/booking-api dev`. Logging in needs an Auth0 tenant (see the
[runbook](docs/runbook.md)).

## Tests

```bash
pnpm lint && pnpm typecheck
pnpm test                   # unit tests
pnpm test:integration       # Testcontainers: real Postgres, Redis and RabbitMQ
pnpm test:contract          # Pact consumer and provider tests (no broker)
pnpm --filter @tickets/system-tests test:system   # black-box flows against a running stack
pnpm --filter @tickets/e2e-tests test:e2e         # Playwright
```

The tests that matter most prove the guarantees directly: 100 parallel attempts on one seat give exactly
one winner, overlapping seat sets do not deadlock, ten identical requests with one idempotency key
create one reservation, and a payment event survives RabbitMQ being down. Load tests live in `tests/load`
(k6).

## Operations

Everything runs on Hetzner Cloud, created with Terraform (`infra/terraform`) and deployed with Kustomize
(`infra/k8s`). A merge to `main` runs the tests, builds the images, runs migrations against both shards
and rolls the deployment out. Day-to-day procedures (restore a backup, switch to load-test mode, seed
events, debug logging) are in the [runbook](docs/runbook.md).

The cluster runs k3s v1.31, which is no longer supported upstream. Upgrading is the next step after the
defence; I held off because it was too risky this close to it.

## Repository layout

```
shared/     auth, db, domain, observability, rabbit, redis, schemas, analytics, types, ui-theme
services/   booking-api, realtime-gateway, scheduler-worker, notification-worker, payment-mock
apps/       web (PWA), scanner (staff web app)
infra/      terraform, k8s (Kustomize)
tests/      e2e (Playwright), system (black-box), load (k6)
docs/       plan, rules, architecture, ADRs, runbook, evidence
```

The code rules (layering, naming, database and security rules) are in [docs/rules.md](docs/rules.md) and
enforced by ESLint.
