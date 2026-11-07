# ADR-0013: Auto mode med sandbox och managed settings

**Status:** Accepted
**Datum:** 2026-11-07
**Ersätter delvis:** [ADR-0012](./0012-agentic-workflow.md), punkten om att auto-läget är avstängt.

## Kontext

ADR-0012 stängde av Auto mode och krävde en fråga för det mesta. Det gav ständiga avbrott utan att skydda
mer än den som klickar ja varje gång. Projektet är ett skolprojekt, och målet är att Claude ska arbeta
självständigt inom ett godkänt `/phase`-scope, medan produktion, hemligheter och deploy förblir hos
utvecklaren. Textmatchning på kommandonamn räcker inte som skydd; det som håller är det operativsystemet
och Claude Codes behörighetsmotor tvingar.

## Beslut

- `permissions.disableAutoMode` tas bort. `disableBypassPermissionsMode` ligger kvar. Auto mode startas
  per session med `claude --permission-mode auto`, inte som standard.
- **Sandbox för Bash** (macOS Seatbelt) slås på i managed settings, som är rotägda och inte går att
  skriva över från projektet: bara `registry.npmjs.org` är nåbart (så ingen push, ingen prod-API och
  inget `ssh`/`kubectl` från Bash), hemliga filer och `infra/terraform` kan inte läsas, och
  `.github/workflows`, `.husky` och `infra/terraform` kan inte skrivas. `allowUnsandboxedCommands: false`.
- `node .claude/hooks/verify.mjs` (båda formerna), `pnpm test:integration` och `pnpm test:contract` körs
  **utanför** sandboxen (`excludedCommands`): de behöver Docker och skriver `.claude/state/`, som är
  skyddat även med `allowWrite`.
- Produktionsverktyg nekas helt i stället för att frågas: `kubectl`, `helm`, `ssh`/`scp`/`sftp`/`rsync`,
  `psql`/`pg_*`, Terraform (apply, destroy, plan, output, show med flera) och `gh` för workflow, secret, repo
  och release. Ändringar i `settings.json`, `.claude/hooks`, `.github/workflows`, `.husky` och
  `infra/terraform` ger en fråga även i Auto mode.

## Vad som är tvingande och vad som inte är det

| | Typ |
|---|---|
| Nätverk, filer och miljövariabler för sandboxade Bash-kommandon | Tvingande (OS). Provat i engångssessioner med `--settings` (14 av 14 skydd höll), men managed-filen är inte installerad förrän användaren kört `sudo`-kommandona |
| Managed settings kan inte ändras av agenten | Tvingande (filrättigheter) |
| `deny`/`ask` på Edit, Write, Read | Tvingande (Claude Code), men en `ask` är ett klick |
| `guard.mjs` | Tvingande kod, men textbaserad och kan kringgås med skript |
| `deny` på kommandonamn | Mjukt; skyddet är sandboxen |
| Klassificeraren, `/phase`-scopet, `CLAUDE.md` | Rådgivande |
| Verifieringspost, Stop-hook, `/review` | Upptäcker, hindrar inte |

## Vad som provats

I engångssessioner med `claude -p --settings` (managed-filen är alltså inte installerad): 14 av 14 skydd höll
(nätverk, hemliga filer, skrivning utanför projektet, miljövariabler, Docker), och `lint`, `typecheck`,
`pnpm test`, `git status/diff/log`, `format:check` och `/verify` fungerar. Lärdomar: hela `infra/terraform` i
`denyRead` ger `EPERM` i `prettier --check .`, så `denyRead` listar bara de hemliga filerna (jokertecken
fungerar); sandboxen låser dessutom `infra/terraform/.kube` som standard, så `format:check` utesluter den
katalogen (`package.json`); `.claude/state` är skyddat även med `allowWrite`, därför `excludedCommands`.

## Kvarvarande luckor

- `patch`, `git apply` och liknande som skriver filer utan att nämna `.claude/…` i kommandot fångas inte av
  guarden; sandboxen (`denyWrite` på hooks, agents, skills och settings) är det som täcker dem.
- De fyra undantagna kommandona kör testkod utanför sandboxen.
- Edit, Write, Read, MCP och hooks körs utanför sandboxen; `WebFetch` begränsas inte av nätverkslistan.
- Reviewerns `permissionMode: plan` gäller inte i Auto mode; skrivskyddet vilar på `disallowedTools`.
- Merge och deploy (`deploy.yml` körs vid push till `main`) skyddas bara tvingande av branch protection på
  GitHub. `phase-status.md` och ADR-0012 säger olika om den finns; det avgörs i GitHub.
- Miljön: skalet som startar Claude ska inte ha `~/.tikknet-tf.env` sourcad.

## Konsekvenser

**Starta inte Auto mode innan managed-filen är installerad.** Utan sandboxen återstår bara reglerna, guarden
och klassificeraren. Mallen ligger i `.claude/managed-settings.example.json`; utvecklaren installerar den med:

```
sudo mkdir -p "/Library/Application Support/ClaudeCode"
sudo install -o root -g wheel -m 644 .claude/managed-settings.example.json "/Library/Application Support/ClaudeCode/managed-settings.json"
```

`config.test.mjs` låser policyn (inget `disableAutoMode`, produktionsverktyg i `deny`, skyddsfiler i `ask`) och
mallens viktigaste egenskaper. `guard.mjs` nekar nu kubectl, helm, ssh, psql och Terraform (utom fmt, validate
och version) oavsett flaggor och omslag, sökning med `grep -r`, `rg -u`, positiva `rg -g` utanför en vitlista av
filändelser, sökningar i hemkatalogen, samt skrivande Bash-kommandon mot `.claude/hooks`, `agents`, `skills` och
settings. `find … | xargs grep` nekas; använd `rg`. Det stänger luckor som ADR-0012 beskrev, men guarden är
textbaserad och är därför inte ett bevis.

## Notering 2026-11-07

Faktaläget, inget beslut ovan ändras. Managed-filen är installerad och var identisk med mallen när den
jämfördes. Texten ovan om att den inte är installerad beskriver läget när beslutet togs.

Tillägg i samma riktning: `scripts/check-secrets.sh`, `.gitleaks.toml` och `.lintstagedrc.json` ger en fråga vid
Edit och ligger i mallens `denyWrite`, och gitleaks körs i CI. Mallens `denyWrite` börjar gälla först när mallen
installerats om.

Ytterligare lucka, samma klass som de undantagna kommandona: skripten i `package.json` saknar `ask`, och
`pnpm test:integration` och `pnpm test:contract` kör dem utanför sandboxen. Det går inte att stänga utan att
även alla testfiler skyddas. `lint-staged` kan också konfigureras där, så pre-commit-kedjan är inte helt låst.
`.gitleaksignore` läses av gitleaks om den skapas och tystar en träff lokalt och i CI. Filen finns inte och saknar
skydd. `.gitleaks.toml` undantar `docs/**/*.md` från skanningen, så hemligheter i dokumentationen hittas inte.

Frågan vid `.claude/hooks/` beror på `ask`-regeln, och utan den skulle klassificeraren ändå avgöra eftersom
`.claude` är en skyddad sökväg. Regeln ligger kvar, eftersom hookarna och `verify.mjs` körs utanför sandboxen.
Vid större hookarbete: se `docs/runbook.md`, "Claude Code-arbetsflödet".
