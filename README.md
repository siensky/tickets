# Tickets

Högkonkurrent biljettbokningsplattform — praktisk examination, Chas Academy.
Platsval på interaktiv arenakarta, 5 000 biljetter, upp till 20 000 samtidiga
besökare, utan att någon stol någonsin säljs två gånger.

**Dokumentation:**

- [docs/plan.md](docs/plan.md) — byggplanen: domän, tjänster, databasschema, infrastruktur, fasplan
- [docs/forsvar.md](docs/forsvar.md) — motivering bakom varje vägval (inför det muntliga försvaret)
- [docs/rules.md](docs/rules.md) — kodregler och säkerhetsspärrar

**Adresser** (fylls i under Fas 1/4):

- API: `https://api.<domän>` — TODO
- CDN: `https://cdn.<domän>` — TODO
- Dashboard (Grafana): `https://grafana.<domän>` — TODO

## Kom igång lokalt

```bash
pnpm install
docker compose up -d        # 2× Postgres, Redis, RabbitMQ
pnpm dev                    # startar alla services + web i parallell
```

Enskild tjänst: `pnpm --filter @tickets/booking-api dev`

## Vanliga kommandon

```bash
pnpm build            # turbo run build
pnpm lint              # turbo run lint
pnpm typecheck         # turbo run typecheck
pnpm test              # turbo run test (unit)
pnpm test:integration  # turbo run test:integration (Testcontainers)
pnpm format            # prettier --write .
```

## Struktur

```
shared/     delad kod (auth, db, rabbit, redis, domain, observability, schemas, analytics, types)
services/   booking-api, realtime-gateway, scheduler-worker, notification-worker, payment-mock
apps/       web (PWA), scanner (Expo, Fas 8)
infra/      terraform, k8s (Kustomize)
tests/      e2e (Playwright), load (k6)
docs/       plan.md, forsvar.md, rules.md, adr/, runbook.md, architecture.md
```

Se [docs/plan.md](docs/plan.md) för den fullständiga strukturen och motiveringen
bakom varje tjänstegräns.
