# ADR-0006: k3s på Hetzner i stället för managed Kubernetes

**Status:** Accepted
**Datum:** 2026-10-30

## Kontext

Uppgiften kräver Kubernetes med minst två instanser, autoskalning och deploy utan nertid.
Projektet är ett soloprojekt med liten budget, och klustret körs inte dygnet runt: större delen
av utvecklingen sker lokalt med docker-compose, och noder skalas upp bara under lasttest och demo.

## Beslut

**k3s på Hetzner Cloud**, skapat med Terraform: en control-plane-nod och en eller flera
workers (CPX22, vid lasttest även CPX32). Hetzner CSI ger nätverksvolymer, ingress-nginx körs
som DaemonSet på varje nod, och Kubernetes-API:et nås bara via Tailscale (ADR-0001).

## Alternativ som övervägdes

- **Managed Kubernetes (t.ex. GKE, EKS, AKS)** — avvisat: en kontrollplan kostar pengar även när
  klustret står stilla, och kontot och faktureringen blir en extra yta att hålla koll på.
  Hetzner debiterar per timme, så ett kluster som bara körs under arbete kostar en bråkdel.
- **Hetzner utan Kubernetes (Docker Compose på en VM)** — avvisat: uppgiften kräver
  HPA, rullande deploy och flera instanser, vilket Kubernetes ger direkt.
- **Hetzner Cloud Load Balancer framför klustret** — se ADR-0007.

## Konsekvenser

Vi äger själva klusteruppgraderingar, certifikat och noder. En känd risk är att k3s `v1.31.4`
inte längre stöds upstream; den uppgraderas inte före försvaret (för riskabelt) och nämns som
nästa steg. I utbyte får vi full kontroll över nodtyper, nätverk och kostnad, och hela klustret kan
byggas om från kod (`terraform apply`).
