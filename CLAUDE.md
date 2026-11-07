# tikknet

Projektets regler gäller fullt ut och står bara på ett ställe:

@docs/rules.md

## Dokument

- Översikt och faser: `docs/plan.md`. Systemet: `docs/specification.md`. En fas: `docs/phases/phase-NN.md`.
  Utfall och läget just nu: `docs/phase-status.md`. Arkitekturbeslut: `docs/adr/`.
- Vad som läses före en fas och en granskning: `docs/rules.md` §11a. Arbetsflödet (`/phase`, `/verify`,
  `/review`) och spärrarna: `docs/adr/0012-agentic-workflow.md`. Auto mode och sandbox: `docs/adr/0013-auto-mode-with-sandbox.md`.

## Kommandon

`pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm test:integration` och `pnpm test:contract` (kräver
Docker; kör dem efter varandra, aldrig samtidigt).

## Arbetssätt

- Svara på svenska.
- Auto mode (`claude --permission-mode auto`) startas först när managed-filen är installerad (ADR-0013). Då
  når sandboxen bara npm: kör integrations- och kontrakttester via `/verify`.
- Åtgärder mot produktion (`kubectl`, `terraform`, `ssh`, lasttestläget) kör användaren själv. Ge
  exakta kommandon, utan `#`-kommentarer i kommandon som ska klistras in i zsh.
