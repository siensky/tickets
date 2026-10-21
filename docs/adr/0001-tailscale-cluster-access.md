# ADR-0001: Tailscale som enda väg till Kubernetes-API:et

**Status:** Accepted
**Datum:** 2026-10-20

## Kontext

Kubernetes-API:et (6443) måste nås av både utvecklarens egen `kubectl` och GitHub Actions,
utan att exponeras publikt — `docs/plan.md` "Säkerhet/Infrastruktur" kräver att det "aldrig
exponeras i den publika brandväggen".

## Beslut

Control-plane-noden går med i ett privat Tailscale-nätverk (tailnet) vid boot. All åtkomst
till 6443, lokal och från CI, går via Tailscale — 6443 öppnas aldrig i `hcloud_firewall`.
Noden ansluter med en icke-ephemeral auth-nyckel (stannar i tailnet mellan omstarter), CI med
en separat ephemeral nyckel (`tag:ci`). `tailscale up --ssh` används INTE (se ADR-0003) och
`--accept-dns=false` sätts explicit.

## Alternativ som övervägdes

- **Öppna 6443 mot en specifik CIDR** (utvecklarens IP + CI:s IP-intervall) — avvisat: CI:s
  utgående IP är inte stabil (GitHub-hostade körare), och ett brett IP-intervall för "CI" är
  i praktiken halva internet.
- **Bastion/jump host** — mer infrastruktur att underhålla för samma resultat Tailscale ger
  gratis.
- **mTLS-klientcertifikat rakt mot publik 6443** — löser autentisering men inte exponeringen;
  6443 skulle fortfarande vara ett skannbart, attackerbart ytelement.

## Konsekvenser

Både utvecklarens dator och CI-körningar måste ansluta till samma tailnet innan de kan nå
klustret — ett extra steg dokumenterat i `infra/terraform/README.md`. I utbyte: 6443 syns
inte i någon portskanning av serverns publika IP, och Tailscale (WireGuard) hanterar
nyckelrotation och kryptering utan att vi bygger det själva. Se `docs/forsvar.md` "Varför
öppnas 6443 aldrig i den publika brandväggen, inte ens mot ett Tailscale-intervall?" för den
fulla motiveringen (inklusive varför ett brandväggshål mot ett "Tailscale-CIDR" inte skulle
ha fungerat).
