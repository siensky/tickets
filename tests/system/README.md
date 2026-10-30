# Systemtester (black-box)

Tester som kör hela flöden mot systemet utifrån, som en klient (docs/plan.md 7.14).
De använder bara det publika HTTP-API:t (booking-api, payment-mock via `checkoutUrl`)
och läsande SQL mot databasen. De importerar aldrig något från `services/` eller
`shared/` (upprätthålls av `no-restricted-imports` i `eslint.config.js`), så de ska
vara gröna utan ändringar om implementationen byts ut men beteendet är samma.

Varje test skapar sitt eget event (`helpers/db.ts`), så ordningen mellan testerna spelar
ingen roll. Filerna körs ändå en i taget (`vitest.config.ts`): F5 ändrar en global
config-rad.

## Flöden

| Fil                     | Flöde                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| `f1-full-purchase`      | Kö → reservation → checkout → betalning → betald order + biljetter |
| `f2-same-seat`          | Två köpare, samma stol: exakt en 201 och en 409                    |
| `f3-max-seats`          | Sex stolar avvisas, inga stolar ändras                             |
| `f4-duplicate-webhook`  | Dubbel webhook ger en order och två biljetter                      |
| `f5-reservation-expiry` | Reservation med 1 minuts hållning går ut (tar ca 1,5 min)          |
| `f6-order-security`     | En annan användares order ger 404                                  |
| `invariants`            | Invarianter över alla events systemtesterna skapat                 |

F7 (skanning) tillkommer med scannern (Fas 7 steg 9).

## Köra lokalt

1. Starta infrastrukturen: `docker compose up -d postgres-shard-0 postgres-shard-1 redis rabbitmq`.
2. Migrera: `bash shared/db/scripts/migrate-all-shards.sh` (med `DATABASE_URL_SHARD_0/1` satta).
3. Bygg och starta `booking-api`, `payment-mock` och `scheduler-worker` med samma miljö som
   `.github/workflows/e2e.yml` (viktigt: `PAYMENT_MOCK_FAILURE_RATE=0`,
   `PAYMENT_MOCK_LATE_WEBHOOK_RATE=0`, `PAYMENT_MOCK_DUPLICATE_WEBHOOK_RATE=1`,
   `PAYMENT_MOCK_LATENCY_MIN_MS=50`, `PAYMENT_MOCK_LATENCY_MAX_MS=200`).
4. Exportera Auth0-uppgifterna för den egna CI-appen "CI System Tests" (docs/plan.md 7.17):
   `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `AUTH0_CI_CLIENT_ID`, `AUTH0_CI_CLIENT_SECRET`,
   `AUTH0_TEST_USER_EMAIL`, `AUTH0_TEST_USER_PASSWORD`, `SYSTEMTEST_USER2_EMAIL`,
   `SYSTEMTEST_USER2_PASSWORD`.
5. `pnpm --filter @tickets/system-tests test:system`

Valfria variabler: `SYSTEM_API_URL` (standard `http://localhost:3000`),
`DATABASE_URL_SHARD_0`, `DATABASE_URL_SHARD_1`.
