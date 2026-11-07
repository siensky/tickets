---
name: phase
description: Tar fram ett uppgiftskontrakt för en fas eller en feature, väntar på godkännande och kör sedan implementation, /verify och /review inom taken för försök. Används som /phase 9 eller /phase "beskrivning".
argument-hint: '<fasnummer | beskrivning>'
disable-model-invocation: true
allowed-tools: Bash(git rev-parse --abbrev-ref HEAD) Bash(git status --short)
---

# /phase $ARGUMENTS

Gren: !`git rev-parse --abbrev-ref HEAD`. Ändringar sedan senaste commit:

!`git status --short`

## 1. Läs så lite som räcker (docs/rules.md §11a)

- `docs/rules.md` är redan inläst via `CLAUDE.md`. Läs den inte igen.
- **Fasnummer:** läs `docs/phases/phase-NN.md` och `docs/plan.md`, avsnittet "Läget just nu" i
  `docs/phase-status.md` och bara de avsnitt i `phase-status.md` och `specification.md` som fasdokumentet
  pekar ut ("Berör", "Utfall"). Hitta avsnitten med `rg -n '^## ' <fil>` och läs dem med offset och limit.
- **Beskrivning utan fas:** läs bara de filer och avsnitt uppgiften rör. ADR:er läses bara om kontraktet
  berör dem.
- Läs koden som berörs och dess diff först. Bredda sökningen (anropare, beroenden) bara med en konkret
  anledning, och säg varför. Läs inte om ett dokument som inte har ändrats.

## 2. Uppgiftskontrakt

Skriv kontraktet i chatten, inte som fil (ADR-0012), och **stanna för godkännande innan något ändras**:

- **Mål:** 1–3 meningar.
- **Underlag:** vilka dokument och avsnitt som lästs.
- **Tillåtna filer och mappar:** exakt. Allt annat är utanför uppgiften.
- **Utanför uppgiften:** uttryckligt, särskilt det som ligger nära.
- **Krav och acceptanskriterier:** testbara. Nya beteenden får tester med lyckat och misslyckat fall (§8).
- **Beroenden och förutsättningar:** inklusive manuella steg för användaren.
- **Verifiering:** vilka steg som krävs lokalt, och vilka som bara körs i CI.
- **Risker och öppna frågor.**

## 3. Implementera

Följ `docs/rules.md`. Kopiera mönstret från närmaste befintliga fil. Inga nya beroenden eller mappar utan
fråga. Behövs en fil utanför kontraktet: stanna och fråga. Aldrig `git add`, `commit`, `push`, `merge`, nya
branches eller PR:er, och inga åtgärder mot produktion (§12).

## 4. Verifiera och granska

1. Kör `/verify`. `FAILED`: rätta inom kontraktet och kör igen. `ENV_ERROR`, `INCOMPLETE` eller `STOP`:
   stanna och fråga. Taket är 6 körningar och nollställs bara av användaren.
2. När verifieringen är `PASSED`: notera `git status --short`, kör `/review` med kontraktet som argument och
   jämför `git status --short` efteråt. En skillnad betyder att granskningen ändrat filer: rapportera den.
3. Åtgärda `KRITISK` och `VIKTIG` `[NU]`, kör `/verify` igen och sedan `/review` en gång till. Efter två
   granskningsomgångar: stanna och rapportera det som återstår. Hoppa aldrig över verifiering eller granskning.

## 5. Rapport

Ändrade filer, raden "Lokal verifiering: …" och tabellen ordagrant, granskningens fynd och vad som åtgärdats,
kvarvarande risker och vad som inte körts lokalt (CI avgör). När en fas är avslutad: uppdatera
`docs/phase-status.md` (§11a). Stanna för användarens godkännande.
