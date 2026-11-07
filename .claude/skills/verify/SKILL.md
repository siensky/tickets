---
name: verify
description: Kör projektets lokala verifiering (lint, typecheck, enhetstester och, när det som ändrats kräver det, integrations- och kontraktstester) och skriver en verifieringspost. Använd efter varje kodändring, innan något rapporteras som klart.
argument-hint: '[full]'
allowed-tools: Bash(node .claude/hooks/verify.mjs) Bash(node .claude/hooks/verify.mjs --scope full)
---

Kör `node .claude/hooks/verify.mjs` (med argumentet `full`: `node .claude/hooks/verify.mjs --scope full`, alla
steg). Exakt så, utan andra flaggor, och med Bash-timeout 600000 eftersom integrationstesterna tar flera
minuter. Återge sedan raden `Lokal verifiering: …` och tabellen **ordagrant**, utan egen sammanfattning.

| Resultat                          | Gör                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PASSED`                          | Säg att den lokala verifieringen är grön och att GitHub Actions `ci-ok` avgör.                                                                                           |
| `FAILED`                          | Rätta felet om det kommer från ändringen och ligger inom kontraktet, och kör `/verify` igen. Ändra aldrig vad ett test förväntar sig och stäng aldrig av ett test (§12). |
| `ENV_ERROR`                       | Miljön fungerar inte (till exempel Docker). Laga inga tester. Stanna och fråga användaren.                                                                               |
| `INCOMPLETE` eller en rad `STOP:` | Taket för försök är nått. Stanna, säg vad som fallerar och fråga användaren. Bara användaren tar bort `.claude/state/verify-attempts.json`; nollställ det aldrig själv.  |

Vid fel nämner rapporten en rad `Felutdata:`. Läs den filen med Read bara när testnamnen inte räcker för att
förstå felet; den är rensad på hemligheter, begränsad i storlek och skrivs över vid nästa körning.

Steg med `not_required` eller `ci_only` har inte körts lokalt, och du påstår aldrig att de är gröna. Posten i
`.claude/state/` skrivs bara av skriptet. Den lokala verifieringen är ett stöd; bara GitHub Actions `ci-ok`
avgör om en PR är godkänd av CI.
