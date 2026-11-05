# Fas 5 — PWA:n och e2e

**Status:** klar och mergad. **Utfall:** [`phase-status.md`](../phase-status.md) "Läget efter Fas 5".

## Mål

**Klar efter review** (se nedan) — G: e2e i pipeline

## Omfattning

Planerat datum: 1/11.

Minimal men komplett PWA: evenemang, väntrum, arenakarta (sektionsvy), reservation, checkout, mina biljetter. TanStack Query. Playwright e2e. **Notering från Fas 3-review:** WS-klienten autentiserar genom att skicka `{"token": "..."}` som sitt FÖRSTA meddelande efter anslutning — token ligger INTE i `/ws?token=...` (loggas annars i klartext). Serversidan väntar 5 s på detta meddelande innan den stänger anslutningen. **Byggdes också i denna fas, eftersom planen förutsatte dem utan att de fanns:** `GET /events`, `GET /events/:id`, venue-sektioner + stolgeometri, per-event stolsstatus, `GET /me/tickets` — fullt lagerindelade (controller/service/repository/mapper). Samt det kvarvarande Fas 3-gapet **"din stol togs"**, kopplat ände-till-ände (markering, omvänt Redis-index, WS-notis, frontend-lyssnare). CORS lades till i booking-api (saknades helt — se Fas 5-review).

## Beroenden

Fas 4 klar.

## Berör

[`specification.md`](../specification.md): "Frontend", "Tester".

## Implementationssteg

Fasen planerades som raden i fastabellen ("Omfattning" ovan), utan numrerade steg.

## Kända luckor efter granskningen

**Fas 5 — kända luckor kvar efter reviewn** (flaggas hellre än göms, samma princip som
Fas 3):

- ~~PWA:n byggs och deployas inte~~ — **löst**: `deploy-frontend`-jobbet i `deploy.yml`
  bygger `apps/web` och laddar upp `dist/` till R2 med `rclone` (samma verktyg som
  backuperna). **Medvetet, inte optimalt val:** delar bucket med databas-backuperna
  (prefix `frontend/`) i stället för en egen bucket — en egen bucket vore renare,
  men är inte prioriterat. Nämn som en förbättringspunkt i muntligt försvar.
  **Ny lucka hittad EFTER första riktiga deployen:** att ladda upp filerna till R2
  kopplar ingenting till domänen — `<domän>` hade ingen DNS-post alls
  (`ERR_NAME_NOT_RESOLVED`). En vanlig R2 "Custom Domain" hade dessutom gjort HELA
  den delade bucketen publik, inklusive backuperna — ett säkerhetsproblem, inte bara
  en smaksak. **Löst:** `infra/terraform/cloudflare-frontend.tf`, en liten Cloudflare
  Worker (`infra/terraform/workers/frontend-proxy.js`) som läser bucketen via sin
  egen R2-binding (aldrig publik åtkomst) och faller tillbaka till `index.html` för
  klientsidig routing (`cloudflare_workers_custom_domain` skapar DNS-posten åt
  apex). Se docs/runbook.md "Frontend-proxy-Workern" för engångsstegen (ny
  behörighet på Terraforms Cloudflare-token + två nya variabler).
  ~~Ny lucka hittad i samma arbete: `realtime-gateway` har fortfarande ingen
  ingress~~ — **falskt larm, upptäckt i Fas 6-reviewn**: `infra/k8s/base/
  realtime-gateway/` har visserligen ingen egen `ingress.yaml`, men routningen
  dit finns redan sedan Fas 3 — `infra/k8s/base/booking-api/ingress.yaml`
  routar `/ws` till `realtime-gateway` på SAMMA host (`api.tikknet.se`),
  matchar planens egen "Trafikväg" (ingen egen WS-subdomän). `wss://
  api.tikknet.se` i `deploy-frontend` fungerar alltså redan.
- ~~Playwright-sviten stannar vid reservationen~~ — **löst**: sviten loggar nu in
  med ett RIKTIGT Auth0-testkonto (automatiserar den riktiga, hostade
  Universal-Login-sidan) och betalar mot payment-mock, ända fram till att
  biljetten med QR-kod syns under "Mina biljetter". **Overifierat:** jag har inte
  kunnat köra detta steget mot en riktig Auth0-tenant under utvecklingen — CI:s
  första riktiga körning är det faktiska testet av inloggnings-automatiseringen
  (se `tests/e2e/specs/booking-flow.spec.ts`s header-kommentar). Kräver de nya
  secrets `AUTH0_WEB_CLIENT_ID`, `AUTH0_TEST_USER_EMAIL`, `AUTH0_TEST_USER_PASSWORD`
  (docs/runbook.md). `createRequireAuth0User` saknar fortfarande ett separat
  HTTP-lagerenhetstest (docs/plan.md Fas 3 "kända luckor") — e2e-sviten täcker nu
  vägen, men inte den isolerade kontraktstesten.
- ~~`eslint-plugin-boundaries` körs inte som CI faktiskt startar den~~ — **löst**:
  `boundaries/root-path` i `eslint.config.js` saknade en ABSOLUT sökväg och
  defaultade därför till `process.cwd()` vid lint-tillfället — `services/*/src/
  controllers/**` m.fl. matchade aldrig när varje paket körde sitt eget
  `eslint .` (det CI faktiskt gör via `turbo run lint`). Satt till
  `import.meta.dirname`. `scripts/verify-boundaries-enforcement.mjs` testar nu
  BÅDA fallen (cwd=repo-rot och cwd=paketkatalog) så regressionen inte kan
  smyga tillbaka obemärkt.

## Acceptanskriterier

Inte formulerat som egna kriterier när fasen byggdes. Målet ovan och kraven i
[`specification.md`](../specification.md) "Kraven och var de uppfylls" gäller.
