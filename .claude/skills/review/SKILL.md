---
name: review
description: Startar den oberoende reviewer-agenten för den aktuella ändringen (grenen mot main plus arbetskatalogen) och returnerar dess fynd. Ändrar ingen kod. Använd när en ändring är klar och verifierad, före slutrapporten.
argument-hint: '[uppgiftskontrakt eller vad som ska granskas]'
context: fork
agent: reviewer
allowed-tools: Bash(git diff --stat main...HEAD) Bash(git status --short) Bash(git log --oneline main..HEAD) Bash(git rev-parse --short HEAD) Bash(git rev-parse --abbrev-ref HEAD)
---

Kontrollera först dina verktyg. Har du Edit, Write eller NotebookEdit är du inte reviewer-agenten
(den laddas bara om `.claude/agents/` fanns när sessionen startade). Granska då inte: svara bara
`Avbrutet: reviewer-agenten är inte laddad. Starta om Claude Code och kör /review igen.`

Granska annars den här ändringen enligt dina instruktioner. Ändra inga filer.

## Uppgiftskontrakt och fokus

$ARGUMENTS

(Är avsnittet ovan tomt finns inget kontrakt: säg det och granska mot `docs/rules.md` och planen.)

## Ändringen

- Gren och HEAD: !`git rev-parse --abbrev-ref HEAD` @ !`git rev-parse --short HEAD`
- Commits sedan main:

!`git log --oneline main..HEAD`

- Filer som ändrats i grenen jämfört med main:

!`git diff --stat main...HEAD`

- Ändringar i arbetskatalogen som inte är committade:

!`git status --short`

Granska både commitsen och arbetskatalogen. Läs diffarna med `git diff main...HEAD -- <fil>` och
`git diff -- <fil>`. Svara med rubrikerna Granskat, Inte granskat, Tester och Fynd.
