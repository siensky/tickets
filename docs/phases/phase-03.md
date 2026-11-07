# Fas 3 — Väntrum, realtid, betalning och auth

**Status:** klar och mergad. Inget eget avsnitt i `phase-status.md` (filen började skrivas efter Fas 3).

## Mål

**Klar efter review** (se nedan) — Flödet komplett

## Omfattning

Planerat datum: 27–28/10.

Väntrum med **signerad stateless kötoken**. `realtime-gateway` + Redis Pub/Sub + **läsbart tillstånd bakom varje WS-meddelande**. `notification-worker` + dedupe + **delivery limit**. `payment-mock`. Stripe: **raw body, rate-limit-undantag, 200-snabbt**, **frysning + återbetalning**. Auth0. Rate limiting.

## Beroenden

Fas 2 klar.

## Berör

[`specification.md`](../specification.md): "Väntrum och botskydd", "Realtid", "Betalning", "Idempotens och meddelanden", "Auth".

## Implementationssteg

Fasen planerades som raden i fastabellen ("Omfattning" ovan), utan numrerade steg.

## Kända luckor efter granskningen

**Fas 3 — kända luckor kvar efter reviewn** (inom Fas 3:s eget scope, inte skjutna till
en senare fas — flaggas hellre än göms):

- **"Din stol togs"** (docs/plan.md "Realtid") är inte kopplad ihop. `shared/redis/src/
  seat-marks.ts` (markSeat/unmarkSeat/getMarkedSeats) finns men anropas ingenstans —
  ingen route markerar en stol, och inget broadcastar till andra kötoken när en markerad
  stol faktiskt tas. Kräver en ny endpoint (markera/avmarkera stol) plus en hook i
  reservationstransaktionen.
- **Slutsålt-flödet** (broadcasta slutsålt, stoppa insläpp, konvertera kön till
  väntelista) är inte byggt. `queue-admission-service.ts` hanterar bara "stängt
  försäljningsfönster" (`sales_close_at` passerad), inte "alla stolar sålda".
  `waitlist`-tabellen finns i schemat men skrivs aldrig till.
- **Köplats-nedräkning och reservationsnedräkning som egna WS-push** är inte byggda —
  bedömt som okritiskt eftersom `GET /queue/status`/`GET /reservations/:id` redan ger
  klienten vad den behöver för att räkna ner själv (samma mönster som planen redan
  beskriver för WS-desync), men värt att se över i Fas 5 när PWA:n faktiskt bygger UI:t.
- **Route-level `inject()`-tester saknas** för de nya routerna (queue join/status,
  reservations POST/GET, checkout, `/webhooks/stripe`) — docs/rules.md §8 kräver minst
  ett lyckat och ett misslyckat fall per route. Service-lagret har gott om tester, men
  inget bevisar Fastify-ledet (raw body på webhooken, rate-limit-undantaget, faktiska
  HTTP-statuskoder).
- **Redis/RabbitMQ-statefulsets saknar `readOnlyRootFilesystem`** (docs/plan.md
  "Säkerhet" kräver det för applikationscontainrar). Inte tillagt blint här eftersom det
  inte går att verifiera mot en riktig k3s-kluster i den här granskningen — vilka extra
  skrivbara sökvägar (t.ex. `/tmp`) de två imagerna faktiskt behöver måste bekräftas vid
  första deploy, annars riskerar man en crash-loop i stället för en säkerhetsvinst.

## Acceptanskriterier

Inte formulerat som egna kriterier när fasen byggdes. Målet ovan och kraven i
[`specification.md`](../specification.md) "Kraven och var de uppfylls" gäller.
