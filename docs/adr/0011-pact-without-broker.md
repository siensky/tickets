# ADR-0011: Pact utan broker

**Status:** Accepted
**Datum:** 2026-10-30

## Kontext

Webbappen, scannern, payment-mock och notification-worker är konsumenter av booking-api (och
realtime-gateway av booking-api/scheduler-worker). Ett API-skifte som bryter en konsument ska fångas i CI.

## Beslut

**Consumer-driven kontraktstester med Pact JS, utan Pact Broker.** Det är ett monorepo, så
konsumenttesterna skriver pact-filer till `pacts/` och providrarna verifierar dem i samma CI-körning
(`pnpm test:contract`). Provider-states seedas med Testcontainers (riktiga Postgres och Redis), på samma
sätt som i integrationstesterna. Kontrakten täcker HTTP (web → booking-api, scanner → booking-api,
payment-mock → booking-api) och meddelanden (booking-api → notification-worker via RabbitMQ,
booking-api/scheduler-worker → realtime-gateway via Redis `ws:*`).

## Alternativ som övervägdes

- **Pact Broker (eller PactFlow)** — nödvändig när konsument och provider ligger i olika repon och
  versioneras var för sig (can-i-deploy). Här deployas allt från samma commit, så en broker vore en extra
  tjänst utan nytta.
- **Bara integrationstester** — de testar providerns beteende, inte vad konsumenterna faktiskt förväntar sig.

## Konsekvenser

`pacts/` är genererat och gitignorerat; verifieringen kräver att konsumenttesterna körs först. Pact
fångar kontraktsformen, inte driftkonfiguration: ett felaktigt webhook-secret (401) hade Pact inte
fångat; det fångas av `loadtest-mode`s paid-kontroll.
