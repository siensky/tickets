# tikknet — roadmap

Översikt över faserna och var allt står. Själva innehållet ligger i dokumenten nedan; den här filen
upprepar det inte.

| Dokument | Svarar på |
|---|---|
| [`specification.md`](./specification.md) | Hur systemet ska bete sig: krav, domän, arkitektur, detaljer per område |
| [`phases/phase-NN.md`](./phases/) | Vad en fas bygger: mål, omfattning, beroenden, steg, acceptanskriterier |
| [`phase-status.md`](./phase-status.md) | Vad som är klart, pågående och nästa, och vad nästa session behöver veta |
| [`rules.md`](./rules.md) | Kodregler och regler för AI-assisterad utveckling (enda källan) |
| [`adr/`](./adr/) | Arkitekturbeslut, se listan nedan |
| [`forsvar.md`](./forsvar.md), [`architecture.md`](./architecture.md), [`runbook.md`](./runbook.md) | Motiveringar, diagram, driftrutiner |

Uppgiftskontrakt (mål, tillåtna filer, acceptanskriterier för en enskild uppgift) skrivs inte som filer.
De tas fram av `/phase` och står i sessionen och i PR-beskrivningen (ADR-0012).

**Arkitekturbeslut:**
[0001 Tailscale till Kubernetes-API:et](./adr/0001-tailscale-cluster-access.md) ·
[0002 DNS-01 och Let's Encrypt staging](./adr/0002-dns01-letsencrypt-staging.md) ·
[0003 privat nätverk via cloud-init](./adr/0003-private-network-bootstrap.md) ·
[0004 två Cloudflare-tokens](./adr/0004-split-cloudflare-tokens.md) ·
[0005 backuper i R2](./adr/0005-backup-storage-r2.md) ·
[0006 k3s på Hetzner](./adr/0006-k3s-on-hetzner.md) ·
[0007 DNS round-robin utan lastbalanserare](./adr/0007-dns-round-robin-without-lb.md) ·
[0008 sharding per event](./adr/0008-sharding-per-event.md) ·
[0009 PostHog EU via proxy](./adr/0009-posthog-eu-reverse-proxy.md) ·
[0010 scannern som webbapp](./adr/0010-scanner-as-web-app.md) ·
[0011 Pact utan broker](./adr/0011-pact-without-broker.md) ·
[0012 dokumentstruktur och arbetsflöde](./adr/0012-agentic-workflow.md) ·
[0013 Auto mode med sandbox](./adr/0013-auto-mode-with-sandbox.md) ·
[0014 CI-loggar utanför sandboxen](./adr/0014-ci-logs-outside-sandbox.md).
Nya beslut skrivs med [mallen](./adr/0000-template.md).

---

## Faser

| Fas | Innehåll | Dokument |
|---|---|---|
| 0 | Repo, tooling, felhierarki, docker-compose | [phase-00](./phases/phase-00.md) |
| 1 | Walking skeleton: Terraform, k3s, TLS, Cloudflare, pipeline hela vägen till deploy | [phase-01](./phases/phase-01.md) |
| 2 | Domänkärnan: schema, shard-router, reservationstransaktionen, idempotens, outbox, kronjuveltesterna | [phase-02](./phases/phase-02.md) |
| 3 | Väntrum, realtime-gateway, notification-worker, payment-mock, Stripe, Auth0, rate limiting | [phase-03](./phases/phase-03.md) |
| 4 | Observability, larm, backups | [phase-04](./phases/phase-04.md) |
| 5 | PWA:n med hela flödet, Playwright, frontend-deploy | [phase-05](./phases/phase-05.md) |
| 6 | HPA, KEDA, zero-downtime-konfiguration, k6-scenarierna, lasttesten | [phase-06](./phases/phase-06.md) |
| 7 | Loki-fix, zero-downtime-beviset, Grafana-demopaneler, återställningsövning, CSV-seed, `cdn.`, ny UI, PostHog, scannern, Pact, systemtester, dokumentation | [phase-07](./phases/phase-07.md) |
| 8 | Snabbare CI, Auth0-utseende, eventlist-cache, cdn-304, session replay, botskydd (PoW + Turnstile), DLQ | [phase-08](./phases/phase-08.md) |

**Arbete efter Fas 8:** lasttestkörningarna och CPU-arbetet (grenarna `loadtest`, `loadtest-fix`,
`spiketest-fix`) planeras i [`loadtest-cpu-plan.md`](./loadtest-cpu-plan.md), inte i ett fasdokument.

Fasplanen hade från början datum (Fas 0 19/10 till Fas 8 efter försvaret 4/11) och omfördelades en gång:

> **Muntligt försvar 4/11. Kodinlämning 8/11.**
>
> Omfördelad efter granskningen: Fas 4 och Fas 6 var kraftigt undertajmade och innehåller
> tillsammans fyra av de betygsgrundande kraven. Omfördelning ensamt räckte inte — därför är
> **PoW/Turnstile, PostHog och scanner-appen flyttade ut ur schemat**. Inget av dem betygssätts.

## Ny fas eller feature

`/phase N` läser `plan.md`, `phases/phase-NN.md`, "Läget just nu" i `phase-status.md` och de avsnitt i
`phase-status.md` och `specification.md` som fasdokumentet pekar ut (`rules.md` §11a), och tar fram
ett uppgiftskontrakt.
`/phase "<beskrivning>"` gör samma sak för en feature utan fasdokument. En ny fas får ett nytt
fasdokument med samma rubriker som de befintliga.

---

## Status

Alla faser är byggda och mergade till `main`.

Vissa delar kräver manuella steg (Auth0, PostHog, Turnstile, `terraform apply`), beskrivna i
runbooken.

### Kända begränsningar

- **NetworkPolicies saknas.** Datatjänsterna är bara nåbara inifrån klustret, men poddarna
  är inte isolerade från varandra
- **Delad databas, inte en per tjänst.** booking-api och scheduler-worker skriver båda till
  `reservations`, `seats` och `outbox` (scheduler-worker: utgång, rensning och "publicerad").
  Radlås, samma låsordning och unika index hindrar krockar, men tjänsterna delar schema och
  måste ändras i takt. Renare: scheduler-worker anropar booking-api (eller en händelse) i stället
  för att skriva själv, eller så körs jobben i booking-api med ledarval
- **Kösidan lyssnar nu på WebSocket** (`admitted`, `sales_closed`, `sold_out`) och pollar bara var
  15:e sekund som reserv. Tidigare pollade den varannan sekund, vilket gav onödig last vid en stor kö
  (docs/loadtest-cpu-plan.md steg 3)
- **Väntelistan** är inte byggd (`waitlist`-tabellen finns men används inte). Kön töms med besked
  vid slutsålt och stängd försäljning
- **Retention** finns bara för `reservations`. `outbox`, `processed_messages` och `idempotency_keys` rensas inte, så de växer
- **Cache hit ratio vid kanten** är inte uppmätt
- **Radering av personuppgifter** finns som princip, inte som funktion
- **k3s 1.31 är EOL** — uppgraderas efter försvaret
- **RPO 24 h** — otillräckligt för riktig försäljning, PITR är nästa steg
- Botskyddets IP-nycklar bör normaliseras till /64 för IPv6
- Dödköerna saknar `x-max-length` och dead-lettering är at-most-once
- Nodskalning är manuell. Ingen cluster-autoscaler

### Inte planerat

ArgoCD + Sealed Secrets · AI-kundtjänst · cluster-autoscaler · point-in-time recovery ·
egen staging-miljö

---

## Hänvisningar från koden

Kodkommentarer skrivna före uppdelningen hänvisar till `docs/plan.md`. De är inte omskrivna (rules.md
§11: ändra inte fler filer än uppgiften kräver). Så här hittar man rätt; ny kod hänvisar direkt till
`specification.md` eller `phases/phase-NN.md`.

| Hänvisning i koden | Står nu i |
|---|---|
| `plan.md 7.N` (7.1–7.19) | [`phases/phase-07.md`](./phases/phase-07.md), steg 7.N |
| `plan.md 8.N` (8.1–8.11) | [`phases/phase-08.md`](./phases/phase-08.md), steg 8.N |
| `plan.md "<rubrik>"` där rubriken finns i `specification.md` | Samma rubrik i [`specification.md`](./specification.md) |
| `"Status"`, `"Kända begränsningar"`, `"Inte planerat"` | Den här filen |
| `"Fasplan"` | "Faser" ovan och `phases/` |
| `"Fas 3/5/6 — kända luckor"`, `"kända luckor"` | `phases/phase-03.md`, `phase-05.md`, `phase-06.md`: "Kända luckor efter granskningen" |
| `"Att ordna parallellt med fas 0"` | [`phases/phase-00.md`](./phases/phase-00.md) |
| `"Context"` | `specification.md` "1. Uppgiften" |
| `"Stolsstatus: ... blå egen markering"` | `specification.md` "2. Domän och användarflöde" |
| `"Appen på <domän>"` | `specification.md` "Klienter och adresser" |
| `"Concurrency-kärnan"` | `specification.md` "4. Bokningskärnan" |
| `"Webhook-hantering"`, `"payment-mock för lasttest"`, `"~5 % fel"` | `specification.md` "Betalning" (och "13. Lasttest" för payment-mock under lasttest) |
| `"t.ex. 300/min"` | `specification.md` "Väntrum" (insläppstakt) |
| `"Din stol togs"` | `specification.md` "6. Realtid" |
| `"Redis — användningsområden"` | `specification.md` "Redis — användning" |
| `"Import av biljettnummer (CSV)"` | `specification.md` "Data in" |
| `"Oversell"` | `specification.md` "7. Databas" och "Hot och motåtgärder" |
| `"Säkerhet"`, `"Säkerhet/Infrastruktur"` | `specification.md` "8. Auth och säkerhet", "Infrastruktur" |
| `"Mina ordrar"`, `"Offline"` | `specification.md` "Webbappen (`apps/web`)" |
| `"Kubernetes — noder"`, `"Kubernetes — arbetslaster"` | `specification.md` "Hetzner, Terraform och k3s", "Tjänster", "Autoscaling" |
| `"Certifikat — DNS-01, och staging först"`, `"staging först"` | `specification.md` "Hetzner, Terraform och k3s" (certifikat) |
| `"Vad som mäts"` | `specification.md` "11. Observability och backups" (mått) |
| `"Rapport och reset"` | `specification.md` "13. Lasttest" |
| `"Demomanus"` | `specification.md` "15. Demomanus för försvaret" |

Den fullständiga gamla planen (med fasplanen) finns i git: `git show be65709:docs/plan.md`.
