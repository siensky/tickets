---
name: verify
description: Kör projektets lokala verifiering (lint, typecheck, enhetstester och, när det som ändrats kräver det, integrations- och kontraktstester) och skriver en verifieringspost. Använd efter varje kodändring, innan något rapporteras som klart.
argument-hint: '[full]'
allowed-tools: Bash(node .claude/hooks/verify.mjs) Bash(node .claude/hooks/verify.mjs --scope full)
---

Kör `node .claude/hooks/verify.mjs`. Är argumentet `full`, kör `node .claude/hooks/verify.mjs --scope full`
(alla steg, även de som ändringarna inte kräver). Kör kommandot exakt så; det tar inga andra flaggor.

Återge sedan raden `Lokal verifiering: …` och tabellen **ordagrant**, och gör så här efter resultatet:

| Resultat                          | Gör                                                                                                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASSED`                          | Säg att den lokala verifieringen är grön och att GitHub Actions `ci-ok` avgör.                                                                                                                              |
| `FAILED`                          | Rätta felet bara om det kommer från ändringen i uppgiften och ligger inom kontraktet. Ändra aldrig vad ett test förväntar sig och stäng aldrig av ett test (`docs/rules.md` §12). Kör sedan `/verify` igen. |
| `ENV_ERROR`                       | Miljön fungerar inte (till exempel Docker). Laga inga tester. Stanna och fråga användaren.                                                                                                                  |
| `INCOMPLETE` eller en rad `STOP:` | Taket för försök är nått. Stanna och fråga användaren.                                                                                                                                                      |

Steg med `not_required` eller `ci_only` har inte körts lokalt. Säg det, och påstå aldrig att de är gröna.
Posten i `.claude/state/` skrivs bara av skriptet; ändra den aldrig själv.
