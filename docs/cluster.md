# Klustret

Hur Kubernetes-klustret ser ut: vilka maskiner som finns, vilka namnrymder, och vad som körs var. Hur
delarna pratar med varandra står i [architecture.md](./architecture.md). Motiveringarna finns i
[ADR-0006](./adr/0006-k3s-on-hetzner.md) (k3s på Hetzner), [ADR-0007](./adr/0007-dns-round-robin-without-lb.md)
(ingen lastbalanserare) och [ADR-0001](./adr/0001-tailscale-cluster-access.md) (Tailscale).

## Maskiner och nätverk

Terraform (`infra/terraform`) skapar servrarna, nätverket, brandväggen och Helm-releaserna. k3s
installeras med cloud-init. Appens manifest ägs inte av Terraform utan deployas av GitHub Actions med
Kustomize.

```mermaid
flowchart TB
  NET((Internet))
  CF["Cloudflare-proxy<br/>tikknet.se, api., grafana."]
  DEV["Admin-dator"]
  GHA["GitHub Actions<br/>deploy.yml"]
  TSN{{"Tailscale-nät (WireGuard)<br/>kubectl mot port 6443"}}

  subgraph HZ["Hetzner fsn1"]
    FW["hcloud_firewall<br/>443 bara från Cloudflare,<br/>22 bara från admin-IP"]
    subgraph PRIV["Privat nät (hcloud_network)"]
      CP["tickets-cp-1<br/>cpx22: 2 vCPU / 4 GB<br/>control-plane + poddar"]
      W1["worker<br/>cpx22: 2 vCPU / 4 GB"]
      DW["demo_workers<br/>cpx32, 0 som standard"]
    end
    LG["loadgen-VM:ar<br/>cpx32, 0 som standard<br/>kör k6"]
    VOL[("Hetzner-volymer (CSI)<br/>Postgres 2 × 10 Gi,<br/>Redis 5 Gi, RabbitMQ 5 Gi")]
  end

  NET --> CF -->|"443, DNS round-robin"| FW
  FW --> CP & W1
  LG -->|"loadtest.tikknet.se<br/>direkt, förbi Cloudflare"| FW
  DEV --> TSN
  GHA --> TSN
  TSN --> CP
  CP & W1 --- VOL
```

## Namnrymder och poddar

```mermaid
flowchart TB
  subgraph ingress-nginx
    IN["ingress-nginx<br/>DaemonSet: en per nod"]
  end

  subgraph cert-manager
    CM["cert-manager<br/>Let's Encrypt, DNS-01"]
  end

  subgraph keda
    KE["KEDA-operator"]
  end

  subgraph ticketing
    BA["booking-api<br/>Deployment, HPA 2–10 (CPU 70 %)<br/>RollingUpdate maxUnavailable 0"]
    RG["realtime-gateway<br/>Deployment, HPA 2–4 (minne)"]
    SW["scheduler-worker<br/>Deployment, exakt 1, Recreate"]
    NW["notification-worker<br/>Deployment, KEDA 1–10<br/>(100 väntande / podd)"]
    PM["payment-mock<br/>1 (4 i loadtest-mode)"]
    MIG["migrations<br/>Job vid varje deploy"]
  end

  subgraph data
    P0[("postgres-shard-0<br/>StatefulSet 1 replik<br/>+ globala tabeller")]
    P1[("postgres-shard-1<br/>StatefulSet 1 replik")]
    RE[("redis<br/>StatefulSet 1 replik")]
    MQ[("rabbitmq<br/>StatefulSet 1 replik<br/>quorum-köer + dödköer")]
    BK["postgres-backup<br/>CronJob 02:30 → R2"]
  end

  subgraph observability
    PR["Prometheus"]
    AM["Alertmanager → Slack"]
    GR["Grafana<br/>grafana.tikknet.se, Auth0"]
    LO["Loki"]
    AL["Alloy<br/>loggar → Loki,<br/>traces → debug-logg tills Tempo finns"]
    TE["Tempo<br/>(byggt, appliceras efter försvaret)"]
  end

  IN -->|"api.tikknet.se, loadtest."| BA
  IN -->|"/ws"| RG
  IN --> GR
  BA & SW --> P0 & P1
  BA & SW & RG & NW --> RE
  SW & BA & NW --> MQ
  MIG --> P0 & P1
  BK --> P0 & P1
  KE -->|"läser ködjup"| MQ
  KE -->|"skalar"| NW
  PR -->|"skrapar /metrics"| BA & RG & SW & NW & P0 & P1 & MQ & RE
  PR --> AM
  AL --> LO & TE
  GR --> PR & LO & TE
```

## Sammanfattning

| Del | Typ | Antal | Varför |
|---|---|---|---|
| booking-api | Deployment + HPA | 2–10 | Stateless, skalar på CPU, minst 2 för deploy utan nertid |
| realtime-gateway | Deployment + HPA | 2–4 | Långlivade anslutningar, skalar på minne |
| scheduler-worker | Deployment, `Recreate` | 1 | Jobben får aldrig köras dubbelt |
| notification-worker | Deployment + KEDA | 1–10 | CPU säger inget om en kö, ködjupet gör det |
| payment-mock | Deployment | 1 | Fejkad Stripe för lasttest |
| Postgres × 2, Redis, RabbitMQ | StatefulSet + volym | 1 vardera | Data överlever omstart. En replik = känd enskild felpunkt |
| migrations | Job | per deploy | Körs före koden, advisory lock |
| postgres-backup | CronJob | varje natt | `pg_dump` till R2, RPO upp till 24 h |
| ingress-nginx | DaemonSet | en per nod | DNS pekar på alla noder, ingen lastbalanserare |
| PodDisruptionBudgets | | | Hindrar att alla repliker tas ner samtidigt |
