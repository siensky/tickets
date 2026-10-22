# Projektregler

Regler för hur kod skrivs i det här repot. Syftet är enhetlig struktur, färre buggar,
och att AI-assisterat bygge inte driver iväg i egen riktning.

**Allt som kan automatiseras fäller bygget.** ESLint-regler är `error`, inte `warn`.
En regel som bara står i en md-fil följs inte när mycket kod genereras.

| Regel | Upprätthålls av |
|---|---|
| Lagergränser | `eslint-plugin-boundaries` → kompileringsfel |
| `any`, `console.log`, default exports | ESLint |
| Maxlängd: 300 rader/fil, 50 rader/funktion | ESLint |
| `strict`-flaggorna | TypeScript |
| Formatering | Prettier |
| Hemligheter | gitleaks (pre-commit + CI) |
| Täckning på `shared/domain` och `shared/db` | Vitest |

---

## 1. Lagerregler

Ett lager anropar bara lagret under sig. Aldrig tvärtom, aldrig hoppa över ett lager.

```
controllers → services → repositories
```

| Lager | Ansvar | Får INTE innehålla |
|---|---|---|
| `controllers/` | Validera in, anropa service, formatera ut | Affärslogik |
| `services/` | Affärslogik | SQL, HTTP, Fastify-typer |
| `repositories/` | All SQL. Returnerar databasrader | Affärslogik, API-objekt |
| `mappers/` | Konvertering databasrad ↔ API-objekt | Allt annat |

**Var logik bor:** används den av *en* tjänst → tjänstens egen `services/`.
Används den av *flera* → `shared/domain/`.

## 2. TypeScript

- `strict: true`, `noUncheckedIndexedAccess: true`
- **Inget `any`** — använd `unknown` och validera
- `as` endast i mappers, med kommentar om varför
- **`@ts-ignore` förbjudet.** `@ts-expect-error` med motivering om det verkligen krävs
- Endast namngivna exporter — inga default exports
- Explicita returtyper på allt som exporteras

## 3. Namngivning

| Sak | Konvention | Exempel |
|---|---|---|
| Filer | kebab-case | `seat-repository.ts` |
| Typer och klasser | PascalCase | `SeatReservation` |
| Funktioner och variabler | camelCase | `reserveSeats` |
| Konstanter | SCREAMING_SNAKE_CASE | `MAX_SEATS_PER_BOOKING` |
| Databaskolumner | snake_case | `event_id` (mappern översätter) |
| Booleans | `is` / `has` / `can` | `isExpired`, `hasActiveHold` |

## 4. Databas

- **All SQL parameteriserad** — aldrig stränginterpolation
- **All SQL i `repositories/`** — ingen SQL någon annanstans
- Varje skrivande operation i en transaktion
- **`ORDER BY` alltid före `FOR UPDATE`**
- **Shard-nyckel (`event_id`) i varje fråga mot shardad tabell** — och `event_id` finns på
  *varje* shardad tabell, även när värdet går att härleda. Routinglagret måste veta vilken
  shard raden ligger på innan frågan ställs.
- **Tider som systemet litar på beräknas alltid med `now()` från Postgres** — aldrig i
  appservern (klockskev mellan poddar), aldrig i klienten (förfalskbart). Gäller
  `expires_at`, `release_after`, `payment_frozen_until`.
- **Migrations måste vara framåtkompatibla** — en ny migration ska kunna köras *innan*
  ny kod deployas. Annars fungerar inte zero-downtime. De körs som ett eget Job med
  advisory lock, mot båda shardarna, aldrig som init-container.

## 5. Felhantering

```
BaseError (abstrakt)
  ├─ message · code · httpStatus · isOperational · context
  ├─ ValidationError        400
  ├─ UnauthorizedError      401
  ├─ ForbiddenError         403
  ├─ NotFoundError          404
  ├─ ConflictError          409
  ├─ GoneError              410
  ├─ TooManyRequestsError   429
  └─ InternalError          500
```

Domänspecifika fel ärver från dessa och återanvänds i hela systemet:

| Fel | Ärver från | Bär med sig |
|---|---|---|
| `SeatUnavailableError` | `ConflictError` | Vilka stolar som var tagna |
| `ReservationExpiredError` | `GoneError` | Reservations-id |
| `QueueTokenInvalidError` | `UnauthorizedError` | — |
| `IdempotencyConflictError` | `ConflictError` | Nyckeln |
| `ShardUnavailableError` | `InternalError` | Shard-nummer |

**`isOperational` skiljer förväntade fel från buggar.** "Stolen är tagen" händer tusentals
gånger under en försäljning och ska **inte** larma. En nullpointer ska larma direkt.

- Domänlagret kastar **domänfel**, aldrig HTTP-fel
- **Inga tomma catch-block**
- **Fel loggas en gång**, i den yttersta felhanteraren — inte i varje lager
- Den yttersta felhanteraren mappar `BaseError` → HTTP-svar, allt annat → 500 + loggrad
  markerad som bugg
- `context` får **aldrig** innehålla hemligheter

## 6. Säkerhet som kodregler

- **Priser beräknas alltid på servern** från databasen. Klientens pris används aldrig
- **Varje fråga efter användardata scopas på autentiserat user-id**, aldrig enbart på
  resurs-id (skydd mot IDOR)
- Zod i **strict mode** — okända fält avvisas
- Request-body sprids **aldrig** rakt in i en databasskrivning
- Aldrig `dangerouslySetInnerHTML`
- Aldrig tokens eller hemligheter i loggar eller URL:er

## 7. Loggning

- Strukturerad JSON via `shared/observability/logger`
- **`console.log` förbjudet i produktionskod**
- Varje request bär ett `requestId` genom alla lager

| Nivå | Betyder |
|---|---|
| `error` | Kräver åtgärd |
| `warn` | Avvikelse värd att notera |
| `info` | Affärshändelse |
| `debug` | Endast utveckling |

## 8. Tester

- **Varje route: minst ett lyckat och ett misslyckat fall**
- **Inga mockade databaser i integrationstester** — Testcontainers med riktiga Postgres,
  Redis och RabbitMQ
- Tester får inte bero på körordning
- **Inga `sleep`** — vänta på villkor
- Testnamn beskriver beteende: `"avvisar reservation när en stol redan är tagen"`

## 9. Kommentarer

**En kort filhuvudkommentar per fil.** Vad filen gör, varför den finns, och eventuell
fallgrop. Inga kommentarer som upprepar vad koden redan säger.

```ts
/**
 * Reservationstransaktionen: låser valda stolar i deterministisk ordning och
 * skapar reservationen allt-eller-inget.
 *
 * Viktigt: ORDER BY id måste ligga före FOR UPDATE, annars uppstår deadlock när
 * två användare väljer överlappande stolar i olika ordning.
 */
```

## 10. Git

- Fritt commit-meddelandeformat — inget verktyg validerar det
- Ingen direkt push till main
- Varje PR måste vara grön
- En PR = en logisk ändring

## 11. Regler för AI-assisterad utveckling

- Innan en ny fil skapas: **leta upp en liknande befintlig fil och följ dess mönster**
- Nya tjänster kopierar strukturen från `booking-api` **exakt**
- **Inga nya mappar** utanför den beslutade strukturen
- **Inga nya beroenden utan att fråga först**
- Arkitekturbeslut i `docs/adr/` ändras inte utan att en ny ADR skrivs
- **Ändra inte fler filer än uppgiften kräver**
- Måste en regel brytas: skriv varför, i koden och i PR:en

## 11a. Fasstatus mellan sessioner

- **Efter varje avslutad fas**, när code review är genomförd och alla findings är
  åtgärdade: `docs/phase-status.md` ska skapas (om den inte finns) eller uppdateras.
  Filen dokumenterar kortfattat viktiga arkitekturbeslut, implementationer, beroenden
  och annan kontext nästa session behöver — kort, relevant, utan onödig upprepning.
- **Vid start av en ny fas** ska huvudagenten läsa både hela `docs/plan.md` och
  `docs/phase-status.md`.
- **Review-subagenten** ska på samma sätt läsa hela `docs/plan.md` och
  `docs/phase-status.md` innan granskningen påbörjas.

## 12. Säkerhetsspärrar — hårda förbud

- **Aldrig `git add`, `git commit`, `git push` eller `git merge`.**
  Alla commits, pushar och merges sköts manuellt av utvecklaren.
- **Aldrig inaktivera eller radera ett test för att få bygget grönt** — fixa testet,
  eller säg rakt ut att det misslyckas
- **Aldrig försvaga en typ, ESLint-regel eller assertion** för att något ska passera
- **Aldrig destruktiva kommandon utan att fråga** — `rm -rf`, `DROP TABLE`,
  `terraform destroy`, `kubectl delete`
- **Aldrig röra `.env`, hemligheter eller Terraform-state**
- **Aldrig köra migrations mot produktion**
- **Kör testerna innan något påstås fungera** — rapportera ärligt vad som hände
- **Vid osäkerhet mellan två vägar: fråga, välj inte tyst**

## Appendix — undantag från §8 ("minst ett lyckat och ett misslyckat fall")

Parameterlösa GET-endpoints utan indata (`/health/live`, `/health/ready`, `/metrics`) har
inget domänfel att testa — "misslyckat fall" för dem betyder fel metod/väg, inte ogiltig
indata. Testas med en POST mot samma path och/eller en okänd path, båda förväntade `404`.
