# ADR-0014: CI-loggar läses via ett fast skript utanför sandboxen

**Status:** Accepted
**Datum:** 2026-11-07
**Kompletterar:** [ADR-0013](./0013-auto-mode-with-sandbox.md), listan över kommandon som körs utanför sandboxen.

## Kontext

Sandboxen i ADR-0013 stoppar `gh`: `~/.config/gh` går inte att läsa, nätverket når bara npm och `GH_TOKEN` är
spärrad. Det var meningen, men det gjorde också att Claude inte kunde läsa CI-loggar. Vid felsökningen av
PR #28 fick utvecklaren köra kommandon och klistra in utdata fram och tillbaka. Utvecklaren vill att Claude
läser loggarna själv, men aldrig committar, pushar eller mergar.

`gh`-inloggningen kan pusha och merga. Utan inloggning ger GitHub bara jobbstatus, inte loggar.

## Beslut

`node /Users/siennalansky/Downloads/tickets/.claude/hooks/ci-logs.mjs` läggs i `allow` och i `excludedCommands`,
med absolut sökväg så att regeln inte matchar en kopia i en underkatalog. Skriptet tar inga argument, får en egen
miljö utan `GH_HOST`, `GH_CONFIG_DIR`, proxy och `PATH` från anroparen, anropar bara `gh run list`, `gh run view`
och `gh run download` mot `siensky/tickets`, och visar den senaste röda körningen på aktuell gren. Utdraget rensas
med samma `redact` som `/verify` och skrivs till `.claude/state/ci-failure.log`.

Spärrarna i ADR-0013 ändras inte i övrigt: `~/.config/gh`, nätverkslistan, `GH_TOKEN` och alla `gh`-regler är
kvar, så `gh` direkt fungerar fortfarande inte i Bash.

## Alternativ som övervägdes

- **Ta bort spärren:** läsrätt till `~/.config/gh` och GitHub i nätverkslistan. Avvisat: inloggningen når då varje
  sandboxat kommando, och `gh api` kan merga. Det bryter mot just villkoret i kontexten.
- **Läsbehörig token i sandboxen:** avvisat för stunden. GitHub tvingar behörigheten, men loggarna omdirigeras till
  `*.blob.core.windows.net`, som då måste öppnas och går att skicka data till.
- **Fortsätta klistra in loggar:** avvisat, det var problemet.

## Konsekvenser

- **"Aldrig pusha eller merga" vilar inte på ett tvingande skydd, och det är en accepterad risk.** Skriptet är
  läsande för att koden är skriven så, inte för att inloggningen är begränsad. Den gränsen fanns inte heller före
  det här beslutet: allt som körs utanför sandboxen når redan samma inloggning, även `pnpm test:integration` och
  `pnpm test:contract` via `package.json` och testfiler, som saknar skydd (ADR-0013). Branch protection är inte
  bekräftad (PR #28 visar `ci-ok` som "Required", kontrollera med kommandot i runbooken). I bästa fall stoppar den
  bara merge med rött bygge till `main`: en grön PR går ändå att merga med inloggningen, och push till andra grenar
  saknar tvingande skydd helt.
- `ci-logs.test.mjs` provar logiken med en fejkad `gh`. Den låser vilka anrop koden gör och vilken miljö `gh` får,
  inte vad `realGh` eller `gh` gör i verkligheten. Hanteringen i `gh run download` (zip-slip, symlänkar) är inte
  granskad.
- Att `verify.mjs` står med relativ sökväg i `excludedCommands` är samma lucka som den absoluta sökvägen här
  stänger. Den är inte ändrad, eftersom testkörarna ändå kör repots kod utanför sandboxen.
- Loggar kan innehålla hemligheter som GitHub inte känner till, och artefakter maskas inte alls. Hela
  `test-results/` hämtas tillfälligt, inklusive traces, men bara `error-context.md` läses. `redact` är bästa möjliga,
  ingen garanti, och utdraget går in i sessionen. Loggar är opålitlig text, och i ett publikt repo kan en fork-PR med
  samma grennamn dyka upp. Rapporten varnar när felet inte gäller aktuell HEAD.
- `excludedCommands` ändras bara genom att mallen installeras om med `sudo` (`docs/runbook.md`). Innan dess stoppas
  skriptet av sandboxen. Att absolut sökväg matchas av `excludedCommands` provas först efter installationen.
- Det är inte provat om `excludedCommands` också undantar sammansatta kommandon (ADR-0013, noteringen).
