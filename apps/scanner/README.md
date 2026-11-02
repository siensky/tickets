# apps/scanner

Biljettscannern för personal vid grindarna (docs/plan.md 7.8): en webbapp på `scan.<domän>`.
Personalen loggar in med vanlig Auth0-inloggning (rollen `staff`, permissionen `scan:tickets`),
väljer event och grind, och läser biljetternas QR-koder med mobilens bakre kamera
(`@zxing/browser`). Resultatet visas i helskärm i 2,5 s: grönt för giltig biljett, rött för
redan skannad, återbetald, spärrad eller okänd.

- Ingen PWA och ingen offline: skanningen kräver nätet (`POST /scans`).
- Temat `tikknet` delas med webbappen via `shared/ui-theme/theme.css`.
- QR-koden innehåller bara `qr_token`. Kontrollen sker på servern; appen litar aldrig på
  permissions i tokenet, den läser dem bara för att välja skärm.

```bash
pnpm --filter @tickets/scanner dev      # http://localhost:5174
pnpm --filter @tickets/scanner test
```

Miljövariabler (`VITE_*`, byggs in): `VITE_API_BASE_URL`, `VITE_AUTH0_DOMAIN`,
`VITE_AUTH0_AUDIENCE`, `VITE_AUTH0_CLIENT_ID` (SPA-appen "Scanner"). Auth0-stegen finns i
`docs/runbook.md` "Biljettscannern".
