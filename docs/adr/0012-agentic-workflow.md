# ADR-0012: Dokumentstruktur och agentiskt arbetsflöde med Claude Code

**Status:** Accepted
**Datum:** 2026-11-05

## Kontext

Projektet byggs med Claude Code. Tre problem har synts:

- **Planen gick inte att följa.** `docs/plan.md` innehöll både systembeskrivningen och hela fasplanen
  (2 239 rader). När den kortades den 3/11 försvann fasplanen ur filen, medan 286 kodkommentarer
  fortfarande hänvisar till dess steg (`plan.md 7.11`, `8.5` …).
- **Reglerna var bara text.** `rules.md` §12 (aldrig `git commit`, aldrig `.env`, aldrig
  migrationer mot produktion) upprätthölls av att utvecklaren klickade nej, och "testerna är körda"
  var ett påstående, inte en kontroll. `rules.md` säger själv att en regel som bara står i en md-fil
  inte följs.
- **Arbetsflödet låg utanför repot**, i en personlig promptfil.

## Beslut

**Dokument.** `docs/plan.md` blir en kort roadmap. Systembeskrivningen flyttas ordagrant till
`docs/specification.md`. Varje fas får ett eget dokument, `docs/phases/phase-NN.md`, med mål,
omfattning, beroenden, berörda avsnitt, implementationssteg och acceptanskriterier; Fas 7 och 8
återställs ordagrant ur git med sin numrering. `phase-status.md` visar utfallet, `rules.md` är enda
källan till regler och `adr/` till arkitekturbeslut. Uppgiftskontrakt skrivs inte som filer.
Kodkommentarerna skrivs inte om; en tabell i `plan.md` visar var gamla hänvisningar står nu.

**Claude Code.** Konfigurationen versionshanteras i `.claude/` och `CLAUDE.md`:

- En ingång, `/phase`, som tar fram ett uppgiftskontrakt, väntar på utvecklarens godkännande och
  sedan själv kör implementation, `/verify` och `/review` inom bestämda tak för antal försök.
- En egen agent, `reviewer`, som granskar i planläge utan verktyg som skriver.
- Spärrar i två lager: neka-regler i `.claude/settings.json` och en PreToolUse-hook som fångar
  kommandovägar reglerna missar. Auto-läget och bypass-läget är avstängda i projektet.
- En lokal verifieringspost som skiljer på godkänt, testfel, miljöfel och steg som inte körts, och en
  Stop-hook som kräver att posten finns.
- Lokal mätning i `.claude/metrics/` (gitignorerad), utan kommandotext eller innehåll.
- GitHub CI (`ci-ok`) med branch protection på `main` är den slutliga kontrollen. Allt lokalt är stöd,
  inte bevis.

## Alternativ som övervägdes

- **Behålla en lång `plan.md`** — avvisat: det var den filen som gick sönder.
- **Dela systembeskrivningen per fas** — avvisat: faserna byggde funktioner tvärs över systemet, så
  beskrivningen skulle splittras och börja motsäga sig själv.
- **Skriva om alla kodkommentarer** — avvisat: en diff i cirka 400 filer, mot `rules.md` §11.
- **Flera parallella implementeringsagenter i worktrees, evals via API, OS-sandbox, Claude i CI** —
  uppskjutet: liten nytta för ett soloprojekt med faser i följd, eller extra kostnad.
- **Bara text i `CLAUDE.md`** — avvisat av samma skäl som §12 fungerade dåligt.

## Konsekvenser

`.claude/` och `docs/phases/` är godkända mappar (`rules.md` §11). Agenterna läser fasdokumentet och
de avsnitt i `specification.md` det pekar ut, inte hela planen (`rules.md` §11a).

**Spärrarna stoppar misstag, inte en agent som aktivt försöker ta sig runt dem.** Ett skript i en
tolk (`node -e`, `python -c`) kan inte bedömas på kommandotexten och blir alltid en fråga till
utvecklaren. Den verkliga gränsen är att `main` kräver en grön `ci-ok`.

Ny kod hänvisar till `specification.md` eller `phases/phase-NN.md`. Gamla hänvisningar till
`plan.md` fungerar via tabellen i `plan.md`.
