# Biljettbokningssystem — byggplan

Byggplanen beskriver **vad** som ska byggas. Motiveringarna till varje vägval ligger i
[`forsvar.md`](./forsvar.md). Kodreglerna ligger i [`rules.md`](./rules.md).

---

## Context

Praktisk examination, Chas Academy. Solo-projekt (kräver lärarens godkännande — uppgiften
anger grupper om 2–3). Mål: VG **och** ett portfolioprojekt som stärker anställbarheten.

### Deadlines

| Datum | Vad |
|---|---|
| ~~fre 16/10~~ | Idé i gruppchatten — **passerad, stäm av med läraren** |
| **ons 4/11** | Muntligt försvar — systemet måste vara demo-klart |
| **sön 8/11** | Kodinlämning |

### G-krav

- Backend på egen VPS, `api.<domän>` över HTTPS
- Statiska filer på `cdn.<domän>`
- CI/CD: varje merge till main testas, byggs och deployas automatiskt
- Unit-, integrations- och e2e-tester i pipelinen
- Dagliga DB-backups till S3
- Metrics och logging

### VG-krav

- ≥2 backend-instanser bakom load balancer
- Deploy utan downtime — noll misslyckade requests
- Autoscaling som ökar **och** minskar med last, demonstrerat live

### Muntligt försvar

Individuella frågor, hela lösningen ska kunna förklaras: demo av app/pipeline/dashboard,
arkitektur (request→databas, merge→deploy), kod och tekniska val, drift och backups, samt
autoscaling och zero-downtime visat under load.

**Inlämning:** repolänk + README med adresser till api, cdn och dashboard.

---

## Domän och användarflöde

Biljettbokning med **platsval på interaktiv arenakarta**. 5 000 platser släpps under ett
15-minutersfönster, upp till 50 000 bokningsförsök (uppgiftens siffra — se "Lasttest").

1. Välj evenemang → arenakarta med sektioner och enskilda stolar
2. Stolsstatus: **grön** ledig · **gul** reserverad av annan · **grå** såld · **blå** egen markering
3. Max 5 stolar per bokning, behöver inte ligga intill varandra
4. "Gå vidare" → **allt-eller-inget**-reservation i 5 minuter, nedräkning startar
5. Inloggning + betalning under reservationstiden → bekräftelse + e-post
6. Vid timeout frisläpps stolarna; väntelista erbjuds när allt är upptaget

---

## Tjänster

| Tjänst | Roll | Repliker |
|---|---|---|
| `booking-api` | Fastify HTTP-API, bokningstransaktionen | 2–10 (HPA) |
| `realtime-gateway` | WebSocket-server | 2–4 (HPA) |
| `scheduler-worker` | Insläpp i väntrum, frisläpp av utgångna reservationer, **outbox-relay**, nattlig rensning | **exakt 1** (`Recreate`) |
| `migrations` (Job) | Kör migrations mot **båda shardarna** före rollout, med advisory lock | Job, per deploy |
| `notification-worker` | RabbitMQ-konsument: e-post, QR, push | 1–10 (KEDA på ködjup) |
| `payment-mock` | Simulerad betalleverantör med konfigurerbart kaos | 1 |
| `ai-service` | *Fas efter VG* — RAG + egen intent-klassificerare (Python) | 1 |

**Ingen backoffice/ops-panel byggs.**

---

## Concurrency-kärnan

**Postgres är sanningen.** Redis avgör aldrig om en stol får reserveras.

Reservation sker i **en transaktion**:

```sql
SELECT * FROM seats
WHERE id = ANY($1) AND event_id = $2
ORDER BY id
FOR UPDATE NOWAIT;
```

- **Allt-eller-inget** — hela reservationen rullas tillbaka om en enda stol är tagen
- **Lazy expiry** — utgången reservation frigörs också vid nästa reservationsförsök mot
  samma stol, utan att invänta `scheduler-worker`. Jämförelsen sker mot **`release_after`**,
  inte `expires_at` — annars är jittret meningslöst (F1)
- **Jittrat frisläpp** — innehavaren behåller exakt 5:00; frisläppandet sprids 0–20 s
- **`expires_at` beräknas alltid med `now()` från Postgres** — aldrig i appservern
  (klockskev mellan poddar), aldrig i klienten (förfalskbart). Se `rules.md §4`
- **`NOWAIT` gäller även mot vårt eget frisläppningsjobb** → enstaka falska 409:or i
  p99-svansen. Medvetet accepterat; nämns i lasttestrapporten

---

## Väntrum

- Redis-baserad kö (ZSET). **Insläppstakt** (t.ex. 300/min) + **sessionstid**
  (15 min totalt, 10 min inaktivitet). Båda i `config`-tabellen, ändringsbara live
- **Kötoken är en signerad stateless token** (HMAC/JWT med `queue_token_id` + `exp`).
  Signaturen ensam räcker för validering i API-lagret — Redis används till **revokering och
  aktivitetsspårning**, inte som enda sanning. Annars blir Redis en enskild felpunkt som kan
  döda hela försäljningen (se `forsvar.md`)
- **En aktiv reservation per kötoken**, upprätthållet i databasen:
  `UNIQUE (queue_token_id) WHERE status = 'active'`
- **Slutsålt:** broadcasta slutsålt, stoppa insläpp, konvertera kön till väntelista
- **Stängt försäljningsfönster** (`sales_close_at` passerad med folk kvar i kön): eget
  tillstånd, kön töms med besked. Lasttestet kommer att producera båda fallen
- Ködjup = autoscaling-signal

---

## Realtid

| Data | Mekanism |
|---|---|
| Arenakartans **geometri** | API-endpoint med `Cache-Control: max-age=2592000`, cachad av Cloudflare |
| Stolarnas **status** | Polling var 2:a sekund mot Redis-cache, 1 s Cloudflare-cache vid kanten |

**Edge-cachen är en förutsättning, inte ett antagande.** Cloudflare cachar *inte* dynamiska
svar som standard, och varje `Set-Cookie` gör svaret ocachebart. Därför:
- Endpointen är **anonym och sätter aldrig cookies**
- **Explicit Cache Rule i Terraform**, inte förlitan på default
- **Hit ratio mäts i Fas 1** och skrivs in här. Faller antagandet måste arkitekturen veta om
  det medan det finns tid att ändra
- Fallback: Redis + in-process microcache, så origin klarar lasten även vid cache-miss

**WebSockets — endast ett-till-ett-fall:**

| Användning | Vad som skickas |
|---|---|
| Köplats | "Du är nummer 4 823", tickar nedåt live |
| Insläpp | "Nu är det din tur" |
| Reservationsnedräkning | Serverstyrd, så klienten inte kan fuska till sig extra tid |
| "Din stol togs" | Markerad stol tas av annan innan du hunnit reservera |
| AI-chatten *(senare fas)* | Strömmande svar |

**Princip: WebSocket är en optimering, aldrig enda leveransvägen.** Redis Pub/Sub är
fire-and-forget — deployas gatewayen i samma sekund som ett insläpp publiceras försvinner
meddelandet, men insläppsplatsen är förbrukad. Därför måste **varje WS-meddelande motsvaras
av tillstånd klienten kan läsa om vid återanslutning** (`GET /queue/status`,
`GET /reservations/:id`). Det löser samtidigt nedräkningens desync när WS tappar.

- WS-klienter återansluter automatiskt med exponentiell backoff
- **Heartbeat var ~30:e sekund.** ingress-nginx `proxy-read-timeout` är 60 s som default —
  utan ping kapas idle-anslutningar konstant, vilket ger återanslutningsstormar som ser ut
  som ett skalningsproblem. `proxy-read-timeout` och `worker-connections` sätts explicit,
  och filedeskriptorgränserna höjs på noderna
- **"Din stol togs" kräver att servern känner till markeringar** — de registreras i ett
  Redis-set per kötoken, annars finns det inget att skicka meddelandet om

---

## Redis — användningsområden

| Användning | Hur |
|---|---|
| Väntrumskön | ZSET med ankomsttid; köplats = rang i mängden |
| Kötoken-**revokering** | `revoked:<id>` — tokenen i sig är signerad och stateless |
| Markerade stolar per kötoken | Set, underlag för "din stol togs" |
| Arenakartans statuscache | `seatmap:<event>:<sektion>` → JSON + versionsnummer |
| Rate limiting | `ratelimit:<ip>`, INCR + EXPIRE |
| Dedupe för notifikationer | Mängd av behandlade meddelande-id med TTL |
| Config-cache | Värdena från `config`-tabellen, **med Pub/Sub-invalidering eller 5 s TTL** |
| **Pub/Sub mellan poddar** | Så `booking-api` kan nå en klient vars WS ligger på annan podd |

**Redis avgör aldrig om en stol får reserveras.**

**AOF-persistens** (`appendonly yes`) på PVC:n. Resten av Redis-användningen tål en omstart
(cache byggs om, rate limits nollställs, dubbla mejl är ofarliga) — det var kön och tokens
som var farliga, och det är löst genom att göra tokenen signerad och stateless.

---

## Botskydd — adaptiv eskalering

1. **Rate limiting per IP** (Redis, ~1 ms) — alltid på
2. **En aktiv reservation per kötoken** — alltid på, upprätthållet av ett partiellt index
3. *Proof of work* vid tokenutfärdande — **flyttat till efter inlämningen**
4. *Cloudflare Turnstile* vid misstänkta signaler — **flyttat till efter inlämningen**

**Rate limiting bakom Cloudflare kräver rätt konfiguration, annars är den värdelös eller
farlig.** Bakom CF ser varje request ut att komma från en CF-IP. Utan åtgärd räknas hela
världen som en användare; litar man naivt på headern kan en angripare sätta den till ett
offers IP och låsa ut dem.

- ingress-nginx: `use-forwarded-headers: true` + `proxy-real-ip-cidr` satt till Cloudflares
  publicerade intervall
- `CF-Connecting-IP` litas på **endast** från CF:s intervall
- Samma princip för allowlistningen av lastgeneratorerna: allowlista den CF-verifierade
  adressen, aldrig en header vem som helst kan sätta
- **Stripe-webhooken undantas från rate limitingen** (eller allowlistas på Stripes
  IP-intervall) — annars 429:as betalningsbekräftelser under rush

---

## Auth

- **Inloggning krävs först vid betalning**, efter reservation. OAuth2 via Auth0 gratisnivå
- Reservationen binds till **kötoken**, inte till inloggning
- **M2M:** NetworkPolicies som baslager + **OAuth2 client credentials för scanner-appen**
- **HMAC-signerad webhook** från betaltjänsten
- Lasttest använder förutfärdade tokens

---

## Betalning

- **Stripe testläge** för det riktiga flödet (Checkout + webhooks).
  Kortuppgifter når aldrig backend
- **`payment-mock`** för lasttest, med konfigurerbart kaos: slumpmässig latens, ~5 % fel,
  **dubbla webhooks**, svar som anländer efter att reservationen löpt ut

### Betalning som landar efter utgången reservation

Den enda punkten i systemet där **riktiga pengar kan försvinna utan återvändo**: Stripe har
dragit beloppet, reservationen har löpt ut, stolarna är sålda till någon annan. Två
mekanismer, inte en:

**1. Frysning (primär).** När Checkout-sessionen skapas går reservationen till
`pending_payment` och **slutar räkna ner**. Eget tak via `payment_frozen_until`
(t.ex. 10 min totalt), och **en aktiv Checkout per kötoken** — annars blir frysningen ett
sätt att hålla stolar gratis.

**2. Automatisk återbetalning (skyddsnät).** Kommer betalningen ändå efter att det frysta
taket löpt ut och stolarna tagits över, återbetalas den automatiskt och ett förklarande mejl
går ut via `notification-worker`.

Frysningen löser det normala fallet; återbetalningen täcker att även frysningen kan ta slut
(fördröjda Stripe-retries, användare som lämnar fliken öppen).

### Webhook-hantering — tre krav

1. **Raw body krävs för HMAC-verifiering.** Fastify parsar JSON innan handlern ser den, så
   signaturen misslyckas *alltid* utan raw-body-konfiguration på just den routen
2. **Undantagen från rate limiting** (se Botskydd)
3. **Svara 200 snabbt, arbeta asynkront:** verifiera signatur → dedupe på händelse-id →
   skriv till outbox → 200 → worker bearbetar. Körs ordertransaktionen synkront timeout:ar
   Stripe och retryar, vilket multiplicerar lasten precis när systemet minst tål det

---

## Idempotens

- Idempotensnyckel på **reservation** och **betalning**:
  `UNIQUE (event_id, scope, key)` med sparat svar
- **`scope` binds till anropande identitet** (kötoken eller user-id) — nyckeln är unik per
  `(event, principal, operation)`. Utan det kan den som gissar eller snappar upp en nyckel
  få tillbaka någon annans sparade svar, med orderdata i
- **In-flight-fallet returnerar 409.** INSERT-vinnaren kör; samtidiga retries träffar
  constrainten men svaret finns ännu inte → `IdempotencyConflictError`, aldrig ett tomt svar
- Webhook-dedupe på leverantörens händelse-id + tidsfönster
- **Transactional outbox + relay** — meddelandet skrivs i samma transaktion som ordern.
  **Relayn bor i `scheduler-worker`** (redan singleton), pollar **båda shardarna**, och
  använder `FOR UPDATE SKIP LOCKED` på outbox-raderna
- **Delivery limit på RabbitMQ-köerna** (quorum-kö med `x-delivery-limit`, eller
  nack-utan-requeue efter N försök). Utan det ger ett giftigt meddelande evig redelivery →
  växande ködjup → KEDA skalar till 10 kraschloopande poddar mitt i lastdemon

**Konsument-dedupe, nivåindelat efter konsekvens:**

| Typ | Mekanism |
|---|---|
| Pengar och biljetter | `processed_messages`-tabell med unique-constraint |
| Notifikationer | Redis-set med TTL |
| Där möjligt | Naturligt idempotent (QR-token är en **HMAC** av `order_id`+`seat_id`) |

---

## Databas

**Två Postgres-poddar i samma kluster.** Shard-nyckel `event_id`. Routinglager hashar,
migrations mot båda, backup av båda, per-shard-paneler i Grafana.

**Globala tabeller (`users`, `faq_documents`, `config`) ligger på shard-0.**
`orders.user_id` är en UUID **utan främmande nyckel**. "Mina ordrar" via **scatter-gather**.

**Regel:** varje shardad tabell bär `event_id`, även när värdet går att härleda.

### Globala tabeller (shard-0)

```
users             id, auth0_sub, email, name, created_at
venues            id, name, city
venue_sections    id, venue_id, name, display_order
venue_seats       id, venue_id, section_id, row, number, x, y
faq_documents     (AI-fasen)
config            key, value
```

### Shardade tabeller

```
events             id, venue_id, title, artist, starts_at,
                   sales_open_at, sales_close_at, status

seats              id, event_id, venue_seat_id, section_id, row, number,
                   price_cents, status, reservation_id, updated_at
                   UNIQUE (event_id, section_id, row, number)

reservations       id, event_id, queue_token_id, status,
                   expires_at, release_after, payment_frozen_until, created_at
                   UNIQUE (queue_token_id) WHERE status = 'active'
                   status: active | pending_payment | converted | expired | cancelled

orders             id, event_id, user_id, reservation_id,
                   total_cents, status, created_at
                   reservation_id: ingen FK (ON DELETE SET NULL om FK ändå används)

payments           id, event_id, order_id, provider, provider_ref,
                   idempotency_key, amount_cents, status, raw_response
                   status: ... | refunded

tickets            id, event_id, order_id, seat_id, qr_token, status,
                   scanned_at, scanned_by
                   UNIQUE (event_id, seat_id) WHERE status = 'valid'

idempotency_keys   event_id, scope, key, request_hash, response_body, status, expires_at
                   UNIQUE (event_id, scope, key)
processed_messages event_id, message_id, consumer, processed_at
outbox             id, event_id, type, payload, created_at, published_at
waitlist           id, event_id, contact, created_at
```

- `seats.status` är en **lagrad kolumn**, uppdaterad i samma transaktion som låser stolen.
  **Invariant som testas och kontrolleras periodiskt:** varje stol med `status='held'` har
  ett `reservation_id` som pekar på en aktiv reservation, och omvänt — en denormaliserad
  kolumn kan annars driva isär obemärkt
- **`tickets.status`** (`valid | refunded | void`) gör indexet partiellt. Garantin mot
  översäljning är kvar, men en återbetald biljett blockerar inte längre återförsäljning
- **`qr_token` är en HMAC-SHA256 med serverhemlighet**, inte en ren hash. Determinismen
  (och därmed idempotensen vid omkörning) bevaras, men ingen utan nyckeln kan tillverka en
  giltig biljett. `order_id` och `seat_id` är inte hemligheter — de syns i API-svar
- **`orders.reservation_id` har ingen FK** (eller `ON DELETE SET NULL`). De ligger på samma
  shard, så en FK *vore* möjlig — men då misslyckas 30-dagarsrensningen tyst
- **Retention (nattligt jobb i `scheduler-worker`):** `reservations` 30 dagar,
  och **`outbox`, `processed_messages` och `idempotency_keys`** efter samma princip — alla
  tre växer obegränsat och snabbt under lasttest
- `config` styr: insläppstakt, reservationstid, jitter-fönster, max stolar/bokning

### Import av biljettnummer (CSV)

Uppgiften bifogar en CSV med de 5 000 giltiga biljettnumren för eventet — de är sanningen
för vad som får säljas, inte något vi genererar själva.

- `seats` får en kolumn **`ticket_number`** (`UNIQUE (event_id, ticket_number)`), det
  CSV-angivna numret. Arenakartans rad/plats/x/y är ett presentationslager ovanpå, inte
  en ersättning för det.
- **Ett engångsimportskript i `scheduler-worker`** (samma tjänst som redan äger
  migrations-liknande engångsjobb), inte en del av request-vägen: läser CSV:n, validerar
  **exakt 5 000 rader och inga dubbletter**, `INSERT ... ON CONFLICT DO NOTHING` per
  `ticket_number`. Idempotent — körs en gång per event innan `sales_open_at`, ofarligt att
  köra om.
- Importen är ett **separat steg i pipelinen**, inte en del av `kubectl apply`: den hör till
  ett specifikt event, inte till deploy av applikationen.

---

## Repo- och filstruktur

```
tickets/
├── shared/
│   ├── auth/                   JWT-verifiering, kötoken, scopes
│   ├── db/                     shard-router, migrations, anslutningspooler
│   ├── rabbit/                 anslutning, publicering, konsumentbas
│   ├── redis/                  klient, nyckelkonventioner, Lua-skript
│   ├── domain/                 affärsregler som FLERA tjänster behöver + errors.ts
│   ├── observability/          logger, metrics, tracing
│   ├── schemas/                Zod-scheman (delas med frontend)
│   ├── analytics/              typade PostHog-händelser + server-SDK
│   └── types/
├── services/                   identisk intern struktur per tjänst
│   ├── booking-api/
│   │   ├── src/
│   │   │   ├── routes/ controllers/ services/ repositories/
│   │   │   ├── mappers/ schemas/ types/
│   │   │   └── index.ts        ingångsfil med start()
│   │   └── tests/
│   ├── realtime-gateway/
│   ├── scheduler-worker/
│   ├── notification-worker/
│   └── payment-mock/
├── apps/
│   ├── web/                    React PWA — kundappen
│   └── scanner/                Expo — dörrvärdens biljettscanner
├── infra/
│   ├── terraform/
│   └── k8s/                    Kustomize: bas + overlays
├── tests/
│   ├── e2e/                    Playwright
│   └── load/                   k6
└── docs/
    ├── plan.md                 denna fil
    ├── forsvar.md              motiveringar inför muntligt försvar
    ├── rules.md                kodregler
    ├── architecture.md
    ├── adr/                    numrerade arkitekturbeslut
    └── runbook.md              vad man gör när något går fel
```

---

## Stack

Node.js · Fastify · TypeScript · pnpm workspaces · Turborepo · Vitest · tsx · Zod ·
Postgres · Redis · RabbitMQ · React + Vite (PWA) · TanStack Query · Expo · Playwright · k6

---

## Tester

- **Integrationstester via Testcontainers** (riktiga Postgres/Redis/RabbitMQ-containrar)
- **Pipeline vid varje merge till main:** lint, typecheck, enhetstester,
  integrationstester, e2e. Lasttester körs separat
- **Täckning:** 90 % på `shared/domain` och `shared/db`. Ingen tröskel på limkod, men
  **varje route måste ha minst ett lyckat och ett misslyckat fall**

### Fyra tester som bevisar systemet

1. **Kapplöpning** — 100 parallella försök på samma stol → exakt 1 lyckas, 99 rena felsvar
2. **Deadlock** — `[5,9]` och `[9,5]` samtidigt → båda slutförs, ingen deadlock
3. **Idempotens** — samma nyckel 10× parallellt → **1 × 200 + 9 × 409**, exakt en order och
   exakt en dragning. ("Alla tio fick samma svar" testar inte det vi tror — det skulle
   förutsätta att nio av dem väntade.)
4. **Outbox** — RabbitMQ nere under köp → meddelandet levereras när den återkommer

Plus **invariantkontrollen `seats` ↔ `reservations`**, och **ett stort e2e-test av hela
flödet**: väntrum → karta → reservation → betalning → bekräftelse → QR-skanning.

**Testcontainers: höj `max_connections`.** Postgres default är 100; kapplöpningstestet med
100 parallella försök får annars "too many connections" istället för stolskonflikten det ska
testa — och misslyckas då av fel skäl. Kör försöken genom en pool.

---

## Infrastruktur

- **Hetzner Cloud + Terraform + k3s**
- **Tailscale:** enda vägen till Kubernetes-API:et (6443) — aldrig exponerat i den publika
  brandväggen, varken för utvecklarens egen `kubectl` eller GitHub Actions. Se
  `docs/adr/0001-tailscale-cluster-access.md`
- **Kostnadsstrategi:** 2× CPX22 (2 vCPU, 4 GB, AMD — cx-serien var inte tillgänglig på
  kontot, se `docs/forsvar.md`), €0,078/h kombinerat ≈ 550 kr/mån vid kontinuerlig drift.
  Eftersom klustret inte körs 24/7 (mesta utvecklingen lokalt, se nedan) blir faktisk
  kostnad en bråkdel av det — Hetzner debiterar per timme. Skala upp till 3–4 noder via
  Terraform-variabel endast under lasttest och demo (några kronor för en körning)
- Mesta utvecklingen sker lokalt med docker-compose
- **Load balancer:** ingress-nginx i klustret
- **Gratis lager:** Cloudflare (DNS + CDN + TLS), Cloudflare R2 eller Backblaze B2
  (backups — **S3-kompatibla**, vilket uppgiftens "dumps till S3" avser), GHCR (registry),
  GitHub Actions (CI), Auth0

### Terraform

- **Äger:** Hetzner-servrar, brandvägg, privat nätverk, **Hetzner CSI**, Cloudflare DNS +
  **Cache Rule** + **SSL-läge Full (strict)**, objektlagring, samt klusterkomponenter som
  sällan ändras (ingress-nginx, cert-manager, KEDA, kube-prometheus-stack)
- **Äger inte:** applikationens manifest — de deployas vid varje merge
- **State: lokal statefil, `.gitignore`:ad.** Innehåller hemligheter i klartext och får
  aldrig committas till det publika repot. Säkerhetskopieras manuellt utanför repot

### Certifikat — DNS-01, och staging först

- **DNS-01 via cert-manager med en Cloudflare API-token**, inte HTTP-01. HTTP-01 genom
  proxad Cloudflare i Full (strict) har ett bootstrap-problem: CF kräver ett giltigt
  origin-cert för att nå origin över 443, men det är just det certet som ska hämtas.
  DNS-01 kräver ingen port 80 alls — vilket matchar brandväggsdesignen — och ger wildcard
- **Let's Encrypt staging-issuer** tills hela kedjan är stabil, byt till prod **en gång**.
  LE ger 5 identiska cert per vecka; upprepade `terraform destroy/apply` bränner dem
- **Cert-secreten säkerhetskopieras utanför klustret**
- **Cloudflare SSL-läge: Full (strict)**, explicit i Terraform. Flexible skickar HTTP mot
  ett origin som bara lyssnar på 443 → trasigt, och är dessutom ett säkerhetshål

### Kubernetes — noder

| Läge | Noder | Totalt |
|---|---|---|
| Utveckling | 2× CPX22 (2 vCPU, 4 GB) | 4 vCPU, 8 GB |
| Lasttest och demo | + 2× CPX32 (4 vCPU, 8 GB) | 12 vCPU, 24 GB |

**Namespaces:** `ticketing` · `data` · `observability` · `ingress-nginx` · `keda` · `cert-manager`

### Kubernetes — arbetslaster

| Workload | Typ | Vila | Topp | CPU req/limit | Minne req/limit |
|---|---|---|---|---|---|
| booking-api | Deployment | 2 | **10** (HPA) | **250m** / 500m | 128Mi / 256Mi |
| realtime-gateway | Deployment | 2 | 4 (HPA) | 250m / 500m | 256Mi / 512Mi |
| scheduler-worker | Deployment **`Recreate`** | **1** | **1** | 50m / 200m | 64Mi / 128Mi |
| notification-worker | Deployment | 1 | **10** (KEDA) | 50m / 300m | 64Mi / 128Mi |
| payment-mock | Deployment | 1 | 2 | 50m / 200m | 64Mi / 128Mi |
| **migrations** | **Job** (per deploy) | — | — | 100m / 500m | 128Mi / 256Mi |
| postgres-shard-0 / -1 | StatefulSet (**Hetzner CSI**) | 1 var | 1 var | 250m / 1000m | 512Mi / 1Gi |
| redis | StatefulSet | 1 | 1 | 100m / 500m | 256Mi / 512Mi |
| rabbitmq | StatefulSet | 1 | 1 | 100m / 500m | 256Mi / 512Mi |
| prometheus | StatefulSet | 1 | 1 | 100m / 500m | 512Mi / 1Gi |
| loki | StatefulSet | 1 | 1 | 100m / 300m | 256Mi / 512Mi |
| grafana | Deployment | 1 | 1 | 50m / 200m | 128Mi / 256Mi |
| ingress-nginx | DaemonSet | per nod | per nod | 100m / 500m | 128Mi / 256Mi |

I vila: ~1,5 vCPU och ~3,5 GB i requests. **PWA:n körs inte i klustret** — den byggs till
statiska filer på `cdn.<domän>`.

**Manifest:** Kustomize — bas per tjänst + en produktions-overlay. Ingen staging-overlay finns (den fanns som en exakt, odifferentierad kopia av bas, och togs bort — se docs/forsvar.md "Varför togs staging-overlayn bort?"); läggs till den dagen en riktig stagingmiljö faktiskt planeras.
**`storageClassName` skrivs ut explicit** i varje StatefulSet. k3s default är `local-path`,
som binder volymen till noden: då blir "döda shard-1 live" ett avbrottstest i stället för ett
failover-test, och en förlorad nod tar shardens data med sig. Att förlita sig på default är
precis hur det här missas.

**Diskutrymme:** `retentionSize` på Prometheus och retention på Loki, med medvetet
dimensionerade PVC:er. kube-prometheus-stack har 10 dagars retention och **ingen
storleksgräns** som default — fylls nodens 40 GB sätter kubelet disk-pressure och evikterar
poddar, vilket mitt i lasttestet ser ut som ett applikationsfel.

### Zero-downtime — kräver alla fyra

1. `readinessProbe` på varje tjänst
2. `maxUnavailable: 0`
3. `preStop`-hook + `terminationGracePeriodSeconds`
4. Graceful shutdown i appen (SIGTERM → sluta ta emot, slutför pågående, stäng pooler)

Plus för WebSockets: klienterna återansluter automatiskt med exponentiell backoff.

**`deploy-under-load` rullar ut endast `booking-api`.** payment-mock har en replik; rullas
den under lasten misslyckas requests och VG-påståendet "noll misslyckade requests" faller.
Det är dessutom den ärliga och den intressanta demonstrationen.

**`scheduler-worker` får `strategy: Recreate`.** `replicas: 1` med RollingUpdate har
`maxSurge: 25%` som **avrundas uppåt till 1** — alltså kan två schemaläggare köra samtidigt
under varje deploy, exakt det som inte får hända. Dessutom tas ett **Postgres advisory lock
vid start**; håller någon annan det avstår processen. Korrektheten ska inte vila på
Kubernetes.

### Probes

- `readinessProbe` → `/health/ready` — kontrollerar att Postgres och Redis går att nå
- `livenessProbe` → `/health/live` — kontrollerar **endast att processen lever**

### Autoscaling

- HPA på `booking-api`: mål 70 % CPU, min 2, max 10. **`requests: 250m`, `limits: 500m`
  (2× request).** HPA räknar utnyttjande mot *requests* — med 100m request visar en podd som
  drar 350m hela 350 % och hoppar direkt till max 10. Demon ska visa en gradvis kurva, inte
  ett språng. **Mät kurvan i Fas 6 före den stora körningen**
- HPA på `realtime-gateway`: minnesbaserad, min 2, max 4. **Nedskalning utlovas inte** —
  Node återlämnar inte minne till OS:et, så RSS stannar uppe efter toppen, och att skala ner
  en WS-gateway dödar aktiva anslutningar. Upp-och-ner demonstreras på booking-api, där det
  är CPU-baserat och ärligt
- **KEDA på `notification-worker`**: RabbitMQ-ködjup, 100 meddelanden/podd, min 1, max 10
- **`behavior.scaleDown.stabilizationWindowSeconds: 60`** (standard är 300)
- **Nodnivå:** egen Terraform-resurs (`hcloud_server.demo_workers`, variabler
  `demo_node_count` + `demo_server_type`, default CPX32) — INTE `node_count`, som delar
  `server_type` med control-plane-noden och hade tvingat en omstart av klustrets hjärna för
  att skala. **Demonoderna provisioneras i förväg** — ingress-nginx är DaemonSet och
  Cloudflare pekar på specifika nod-IP:n, så nya noder får ingen trafik förrän A-posterna
  uppdaterats och TTL:en löpt ut. VG kräver att *instansantalet* skalar, vilket HPA och KEDA
  sköter; nodnivå nämns som nästa steg

**NetworkPolicies** mellan tjänster. **PodDisruptionBudget `maxUnavailable: 1`** för
enreplikstjänster (eller ingen PDB) — `minAvailable: 1` kan aldrig uppfyllas med en podd,
så `kubectl drain` skulle hänga för alltid.

### Trafikväg

```
Webbläsare
  → Cloudflare (TLS, cache, Turnstile)
  → A-post mot nodens publika IP:443
  → ingress-nginx (DaemonSet på varje nod) — ruttar via värdnamn
  → Service (ClusterIP) — lastbalanserar över friska poddar
  → booking-api-podd
  → shard-router: hash(event_id)
  → Postgres-podd (shard-0 eller shard-1)
```

### Deploy

- **Fas 1: kubectl från GitHub Actions** — G-kravet grönt tidigt.
  Kedjan är: bygg image → GHCR → **migrations-Job mot båda shardarna** → `kubectl apply` →
  `rollout status`. **Pipelinen avbryter deployen om migrationen misslyckas**
- **Migrations körs aldrig som init-container** i booking-api — 2–10 repliker skulle tävla
  om att migrera samtidigt. Ett separat Job med **Postgres advisory lock**
- **Efter inlämningen: ArgoCD (GitOps)**

### Secrets

- **Nu:** GitHub Actions secrets → Kubernetes Secrets vid deploy
- **`--secret-encryption` påslaget i k3s** — Kubernetes-secrets ligger annars okrypterade
  i etcd
- **Deploy-jobbet triggas endast på push till main**, aldrig `pull_request_target`.
  Forkade PR:er når inga secrets
- **Efter inlämningen:** Sealed Secrets tillsammans med ArgoCD

---

## Observability

**kube-prometheus-stack** installeras via Terraform. **Loki + Alloy** för loggar och traces.
**OpenTelemetry-instrumentering från dag ett** i `shared/observability`;
**Tempo kopplas in efter att VG-kraven är säkrade.**

**Prometheus hämtar (pull)** — varje tjänst exponerar `GET /metrics` via `prom-client`,
Prometheus skrapar var 15:e sekund. Poddar hittas via `ServiceMonitor`-resurser.

| Komponent | Hur metrics exponeras |
|---|---|
| booking-api, gateway, workers | `/metrics` direkt via `prom-client` |
| postgres-shard-0 / -1 | `postgres-exporter` som sidecar |
| redis | `redis-exporter` som sidecar |
| rabbitmq | Inbyggd Prometheus-plugin, aktiveras |
| Noderna (CPU, disk) | `node-exporter` som DaemonSet |
| Kubernetes-objekt | `kube-state-metrics` |

### Vad som mäts

- **Per endpoint (RED):** requesttakt, felfrekvens, svarstid p50/p95/p99
- **Affär:** aktiva reservationer, ködjup, insläppstakt, sålda biljetter, konverteringsgrad
- **Infrastruktur:** databasanslutningar **per shard**, låskonflikter, transaktionstid,
  RabbitMQ-ködjup, konsumenttakt, DLQ-storlek
- **`oversell_prevented_total`** — räknare som ökar när ett insert på `tickets` fallerar på
  unique violation, alltså när databasen *förhindrade* en översäljning.
  (En räknare för "översäljning inträffade" vore en tautologi — constrainten gör det
  omöjligt, så den kunde aldrig öka och bevisade därmed ingenting.)

**Larm:** Alertmanager → **Slack-webhook**. Ett larm triggas medvetet under demon.

**Grafana skyddas med OAuth-inloggning via Auth0** — adressen kan ligga i README som
uppgiften kräver, men bara behöriga kommer in. **Anonym åtkomst är avstängd och inget
default-admin ligger i en committad values-fil.**

---

## Backups

- Nattligt `pg_dump` av **båda** shardarna → R2/B2, 7 dagars rullande historik
- **Dokumenterad och faktiskt genomförd återställningsövning** i `runbook.md`, med
  tidtagning

---

## Klienter

**Två appar, inte tre.**

**`apps/web` — React PWA.** Kundappen. Körs i webbläsaren och kan *installeras*: ikon på
hemskärmen och helskärm på mobil, eget fönster och dock-ikon på desktop. En kodbas täcker
webb, mobil och desktop för kunder. Ingen Electron, ingen React Native här.

**`apps/scanner` — Expo (React Native).** Dörrvärdens app, för telefon. Native eftersom
den behöver kameran för QR-skanning och lokal lagring för offline-kön. Autentiserar via
OAuth2 client credentials. Postar skanningar över HTTP — behöver ingen WebSocket.

### Webbappens tekniska val

- **Arenakartan:** liten arena → alla platser visas direkt. Större arena → sektionsvy, och
  man klickar på en sektion för att se dess stolar. Minskar både rendering och polling-last
- **Serverdata: TanStack Query** — `refetchInterval`, cache, deduplicering, omförsök med
  backoff, och **pausad polling när fliken är dold**
- **Lokal data: Reacts `useState` + context** — inget extra state-bibliotek
- **Offline:** appskalet + **mina biljetter med QR-koder**. Bokning fungerar inte offline
  och ska visa det tydligt. **Inga push-notiser** i detta skede
- *PostHog (funnel + session replay)* — **flyttat till efter inlämningen**. Paketet
  `shared/analytics` finns redan och definierar händelserna; kritiska
  konverteringshändelser (`payment_succeeded`) ska skickas **serversidigt** när det byggs
- **Deployment:** byggs i CI till statiska filer → R2/B2 → Cloudflare.
  Appen på `<domän>`, tillgångar på `cdn.<domän>`, API:et på `api.<domän>`

---

## Säkerhet

### Biljettinventariet

| Hot | Motåtgärd |
|---|---|
| Denial of inventory | En aktiv reservation per kötoken (partiellt index), rate limiting |
| Kökringgående | Kötoken är **signerad och stateless**, valideras i API-lagret |
| Tokenhandel | Kort TTL, token bunden till session, engångsinsläpp, revokering i Redis |
| Massuppköp | Max 5 stolar/bokning + gräns per konto |
| Biljettförfalskning | `qr_token` är **HMAC-SHA256 med serverhemlighet**, inte en ren hash |

### Betalningar

- **Prismanipulation** → servern beräknar alltid totalen från stolsraderna i databasen
- **Förfalskad webhook** → HMAC-verifiering (**kräver raw body**) + verifiering mot
  leverantörens API innan ordern bekräftas
- **Replay** → dedupe på händelse-id + tidsfönster
- **Betalning efter utgången reservation** → **frysning vid Checkout + automatisk
  återbetalning som skyddsnät** (se avsnittet *Betalning*)
- **PCI DSS undviks helt** → Stripe Checkout; kortuppgifter når aldrig backend

### Auth och behörighet

- **IDOR** → varje fråga scopas på autentiserat user-id, aldrig enbart på resurs-id
- **JWT** → verifiera mot Auth0:s JWKS, lås algoritmen, kontrollera `aud`, `iss`, `exp`
- Tokens aldrig i URL:er — enbart i `Authorization`-headern
- **Mass assignment** → Zod strict mode; request-body sprids aldrig rakt in i en skrivning

### Applikationen

SQL injection → parameteriserad SQL · XSS → `dangerouslySetInnerHTML` förbjudet ·
CSRF → bearer-tokens i header istället för cookies · Prompt injection *(AI-fasen)* →
AI:ns verktyg scopas serversidigt till inloggad användare

### Infrastruktur

- Datatjänster: ClusterIP + brandvägg, ingen publik exponering
- **Endast port 443 öppen**, och bara från Cloudflares IP-intervall.
  SSH (22) och Kubernetes-API (6443) låsta till egen IP
- **`CF-Connecting-IP` litas på endast från CF:s intervall** (se Botskydd) — annars är
  rate limitern antingen verkningslös eller ett vapen mot användarna
- **gitleaks** som pre-commit-hook och i CI
- **k3s `--secret-encryption`** påslaget
- **Deploy-workflow triggas endast på push till main**, aldrig `pull_request_target`
- Containrar: `runAsNonRoot: true`, read-only rotfilsystem, droppade capabilities.
  **Avsiktligt undantag: Postgres-poddarna.** Den officiella `postgres:17-alpine`-imagens
  entrypoint kör som root vid start för att `chown` datakatalogen innan den själv växlar till
  `postgres`-användaren (`gosu`) — ett `securityContext` som tvingar `runAsNonRoot` hade gjort
  containern oförmögen att starta. Gäller bara databasens egen image, inte
  applikationscontainrarna
- Lockfile committad, pinnade versioner

### GDPR

IP-adresser anonymiseras i loggar · retentionspolicy · **redaktionslista i loggern** ·
(cookie-samtycke och maskerad session replay när PostHog byggs, efter inlämningen)

**Radering sker genom anonymisering, inte hård radering.** Bokföringslagen kräver 7 års
bevarande av bokföringsmaterial, och en hård radering skulle dessutom förstöra giltiga
biljetter för evenemang som ännu inte ägt rum. Personuppgifter i `users` nollas;
`orders` och `payments` behålls med ett anonymiserat `user_id`. GDPR art. 17(3)(b) tillåter
uttryckligen detta när en rättslig förpliktelse kräver bevarande.

---

## Lasttest

**Generering:** 2–3 Hetzner-maskiner provisionerade med Terraform, körs några timmar och
rivs.

**Huvudkörningen går mot ett separat värdnamn direkt mot ingress**, med brandväggen öppnad
för generatorernas IP:n. Två skäl: du mäter ditt system och inte Cloudflares nät, och
20 000 VU genom CF:s gratisplan ligger i gränslandet för deras användarvillkor. **Ett
mindre CF-proxat test körs också** — annars går cache-påståendet inte att belägga.

**Lastgeneratorernas CF-verifierade adresser allowlistas i rate limitern** under testet, med
dokumenterad motivering — annars mäter testet vårt eget botskydd i stället för systemet.

**Höj `ip_local_port_range`, `somaxconn` och fd-gränser** på både generatorer och noder.
Portutmattning är inte den bindande begränsningen vid 3 maskiner (~6 700 anslutningar per
käll-IP ligger under taket) — det som biter är k6:s per-VU-modell för WebSockets och
filedeskriptorgränserna.

| Scenario | Vad det gör |
|---|---|
| `smoke` | 10 VU — verifierar att hela flödet fungerar |
| `queue-storm` | 50 000 VU ansluter inom 60 s; mäter väntrummet |
| `normal-sale` | **Betygsgrundande normaltest.** 50 000 bokningsförsök utspridda jämnt över 15 min |
| `spike-sale` | **Betygsgrundande spiketest.** 50 000 bokningsförsök över 6 min, medvetet ojämn — perioder med få VU och korta, tydliga toppar |
| `deploy-under-load` | `normal-sale` medan en ny version rullas ut |
| `shard-failure` | Shard-1 dödas mitt under lasten |

`queue-storm`-siffran (50 000) matchar nu uppgiftens volym, inte vårt tidigare egna antagande
på 20 000 — väntrummet ska klara samma skala som bokningsförsöken.

**Mätpunkter:** p50/p95/p99, felfrekvens, **`oversell_prevented_total`**, poddantal över
tid, ködjup, databasanslutningar per shard, **cache hit ratio vid kanten**.

### Rapport och reset — `normal-sale` och `spike-sale`

De två betygsgrundande körningarna ska vara granskningsbara i efterhand, enligt
uppgiftstexten. Varje körning skriver en egen rapportfil (k6:s `--summary-export` +ett eget
skript mot `oversell_prevented_total`/ordertabellen) med: testkonfiguration (VU-profil,
scenario), starttid, faktiskt antal förfrågningar, svarstider (p50/p95/p99), genomströmning,
felfrekvens, och antal slutförda köp — plus ett explicit bevis på att sålda biljetter ≤ 5 000
och att inget `ticket_number` förekommer i mer än en order (samma fråga som
kronjuveltestet, körd mot produktionsdatan efter testet, inte bara i CI).

**Reset mellan körningarna:** ett `scheduler-worker`-skript återställer samtliga `seats` till
`available` och tömmer `reservations`/`orders`/`tickets`/`payments` för eventet (samma
engångsklass av jobb som CSV-importen), så `spike-sale` startar från samma 5 000 tillgängliga
biljetter som `normal-sale` gjorde. Körs manuellt mellan de två körningarna, aldrig
automatiskt — ett skript som tömmer ordrar ska inte kunna triggas av ett misstag i CI.

**Tidta pipelinen.** Lint + typecheck + unit + integration (Testcontainers) + Playwright blir
realistiskt 10–20 min. Demomanusets punkt 2 är "en merge genom pipelinen" — ha något att
prata om under tiden, eller lägg e2e efter deploy mot staging.

---

## Fasplan

**Muntligt försvar 4/11. Kodinlämning 8/11.**

Omfördelad efter granskningen: Fas 4 och Fas 6 var kraftigt undertajmade och innehåller
tillsammans fyra av de betygsgrundande kraven. Omfördelning ensamt räckte inte — därför är
**PoW/Turnstile, PostHog och scanner-appen flyttade ut ur schemat**. Inget av dem betygssätts.

| Fas | Datum | Innehåll | Mål |
|---|---|---|---|
| ~~**0**~~ | ~~19/10~~ | ~~Repo, tooling, felhierarki, docker-compose~~ | **Klar** |
| **1** | 20–22/10 | **Walking skeleton.** Terraform: 2 noder, brandvägg, privat nät, **Hetzner CSI**. k3s, ingress-nginx, **cert-manager med DNS-01 + LE staging**, CF **Full (strict)** + **Cache Rule** + **CF-Connecting-IP-konfiguration**. Actions: lint → typecheck → test → image → **migrations-Job** → `kubectl apply` → `rollout status`. **Mät cache hit ratio.** | **G: automatisk deploy** |
| **2** | 23–26/10 | **Domänkärnan.** Schema + migrations mot båda shardarna. Shard-router. Reservationstransaktionen (`release_after`, `now()` från Postgres). Idempotensnycklar med `event_id` + principal-scope. Outbox + relay i `scheduler-worker`. **De fyra kronjuveltesterna** + invariantkontrollen. | Projektets hjärta |
| **3** | 27–28/10 | Väntrum med **signerad stateless kötoken**. `realtime-gateway` + Redis Pub/Sub + **läsbart tillstånd bakom varje WS-meddelande**. `notification-worker` + dedupe + **delivery limit**. `payment-mock`. Stripe: **raw body, rate-limit-undantag, 200-snabbt**, **frysning + återbetalning**. Auth0. Rate limiting. | **Klar efter review** (se nedan) — Flödet komplett |
| **4** | 29–31/10 | kube-prometheus-stack, Loki + Alloy, OTel-instrumentering. **`retentionSize` + PVC-dimensionering.** Dashboards, `oversell_prevented_total`, larm → Slack. Nattlig `pg_dump` av båda shardarna → R2 (se `docs/adr/0005-backup-storage-r2.md`) + runbook-skript för återställningsövningen (ej ännu körd mot riktigt kluster — kräver Tailscale-åtkomst). **Fas 3-review-noten löst:** den egna `rabbitmq_queue_messages_ready`-gaugen (queue-depth-metric.ts) är borttagen; RabbitMQs eget `rabbitmq_prometheus`-plugin är källan nu. | **Klar efter review** (se nedan) — G: metrics, logging, backup |
| **5** | 1/11 | Minimal men komplett PWA: evenemang, väntrum, arenakarta (sektionsvy), reservation, checkout, mina biljetter. TanStack Query. Playwright e2e. **Notering från Fas 3-review:** WS-klienten autentiserar genom att skicka `{"token": "..."}` som sitt FÖRSTA meddelande efter anslutning — token ligger INTE i `/ws?token=...` (loggas annars i klartext). Serversidan väntar 5 s på detta meddelande innan den stänger anslutningen. **Byggdes också i denna fas, eftersom planen förutsatte dem utan att de fanns:** `GET /events`, `GET /events/:id`, venue-sektioner + stolgeometri, per-event stolsstatus, `GET /me/tickets` — fullt lagerindelade (controller/service/repository/mapper). Samt det kvarvarande Fas 3-gapet **"din stol togs"**, kopplat ände-till-ände (markering, omvänt Redis-index, WS-notis, frontend-lyssnare). CORS lades till i booking-api (saknades helt — se Fas 5-review). | **Klar efter review** (se nedan) — G: e2e i pipeline |
| **6** | 2–3/11 | HPA (**requests 250m**) + KEDA, `scaleDown` 60 s. Zero-downtime: probes, `maxUnavailable: 0`, preStop, graceful shutdown, **`Recreate` på scheduler-worker**. k6-scenarier, lastgeneratorer, fd-gränser. **Mät HPA-kurvan, sedan den stora körningen.** **Notering från Fas 4-review:** `RabbitMQQueueDepthHigh`-larmets tröskel (900, `infra/k8s/base/monitoring/prometheusrule.yaml`) antar redan KEDAs planerade tak (100 meddelanden/podd × 10 poddar) — dubbelkolla att siffran fortfarande stämmer när `ScaledObject`:en faktiskt byggs här. **Noteringar från Fas 3-review, innan `queue-storm`:** (1) `realtime-gateway` ger varje WS-klient sin egen duplicerade Redis-anslutning (`subscribeToChannel`) — vid 50 000 samtidiga klienter går det långt över Redis standardgräns på 10 000 anslutningar; bör bli EN subscriber per podd (`psubscribe ws:*` + en lokal kanal→socket-tabell) innan lasttestet körs. (2) `queue_session_total_minutes`/`queue_admission_rate_per_minute` måste tunas till queue-storms skala — kötokenets JWT-`exp` sätts vid JOIN, inte vid insläpp, så med låg insläppstakt och djup kö hinner token gå ut innan användaren släpps in; `admitNextBatch` (ZPOPMIN) märker heller inte redan utgångna token innan den "släpper in" dem, vilket slösar insläppskvoten på döda poster. | **VG** |
| — | **4/11** | **MUNTLIGT FÖRSVAR** | |
| **7** | 5–8/11 | `architecture.md`, ADR:er, `runbook.md` med **RPO/RTO**, README med adresser. Polering. | **Inlämning 8/11** |

**Fas 3 — kända luckor kvar efter reviewn** (inom Fas 3:s eget scope, inte skjutna till
en senare fas — flaggas hellre än göms):

- **"Din stol togs"** (docs/plan.md "Realtid") är inte kopplad ihop. `shared/redis/src/
  seat-marks.ts` (markSeat/unmarkSeat/getMarkedSeats) finns men anropas ingenstans —
  ingen route markerar en stol, och inget broadcastar till andra kötoken när en markerad
  stol faktiskt tas. Kräver en ny endpoint (markera/avmarkera stol) plus en hook i
  reservationstransaktionen.
- **Slutsålt-flödet** (broadcasta slutsålt, stoppa insläpp, konvertera kön till
  väntelista) är inte byggt. `queue-admission-service.ts` hanterar bara "stängt
  försäljningsfönster" (`sales_close_at` passerad), inte "alla stolar sålda".
  `waitlist`-tabellen finns i schemat men skrivs aldrig till.
- **Köplats-nedräkning och reservationsnedräkning som egna WS-push** är inte byggda —
  bedömt som okritiskt eftersom `GET /queue/status`/`GET /reservations/:id` redan ger
  klienten vad den behöver för att räkna ner själv (samma mönster som planen redan
  beskriver för WS-desync), men värt att se över i Fas 5 när PWA:n faktiskt bygger UI:t.
- **Route-level `inject()`-tester saknas** för de nya routerna (queue join/status,
  reservations POST/GET, checkout, `/webhooks/stripe`) — docs/rules.md §8 kräver minst
  ett lyckat och ett misslyckat fall per route. Service-lagret har gott om tester, men
  inget bevisar Fastify-ledet (raw body på webhooken, rate-limit-undantaget, faktiska
  HTTP-statuskoder).
- **Redis/RabbitMQ-statefulsets saknar `readOnlyRootFilesystem`** (docs/plan.md
  "Säkerhet" kräver det för applikationscontainrar). Inte tillagt blint här eftersom det
  inte går att verifiera mot en riktig k3s-kluster i den här granskningen — vilka extra
  skrivbara sökvägar (t.ex. `/tmp`) de två imagerna faktiskt behöver måste bekräftas vid
  första deploy, annars riskerar man en crash-loop i stället för en säkerhetsvinst.

**Fas 4 — löst efter ditt beslut om oversold-stolar:** en stol som förlorar
`tickets_valid_seat_unique`-racet återbetalas individuellt (Stripe partial refund,
`order.seat_refunded`-mejl) medan resten av ordern bekräftas som vanligt
(`payment-refund-service.ts`, `mintTicketsForSeats`s per-stol SAVEPOINT). Om ALLA
stolar i en order krockar faller den tillbaka till en full återbetalning (samma väg
som en utgången reservation). En redelivery efter en krasch MELLAN Stripe-anropet och
outbox-skrivningen räknar om vilka stolar som saknar biljett direkt från
`tickets`-tabellen (ingen egen "pending"-markör) — se kommentarerna i
`payment-consumer-service.ts`/`payment-refund-service.ts`.

**Fas 5 — kända luckor kvar efter reviewn** (flaggas hellre än göms, samma princip som
Fas 3):

- ~~PWA:n byggs och deployas inte~~ — **löst**: `deploy-frontend`-jobbet i `deploy.yml`
  bygger `apps/web` och laddar upp `dist/` till R2 med `rclone` (samma verktyg som
  backuperna). **Medvetet, inte optimalt val:** delar bucket med databas-backuperna
  (prefix `frontend/`) i stället för en egen bucket — en egen bucket vore renare,
  men är inte prioriterat. Nämn som en förbättringspunkt i muntligt försvar.
  **Ny lucka hittad i samma arbete:** `realtime-gateway` har fortfarande ingen
  ingress (`infra/k8s/base/realtime-gateway/` saknar `ingress.yaml`) — `wss://
  api.tikknet.se` i `deploy-frontend` är den TILLTÄNKTA adressen, men routningen
  dit finns inte än. Ofarligt eftersom WS bara är en optimering (REST-pollning
  täcker allt), men bör in i Fas 6.
- ~~Playwright-sviten stannar vid reservationen~~ — **löst**: sviten loggar nu in
  med ett RIKTIGT Auth0-testkonto (automatiserar den riktiga, hostade
  Universal-Login-sidan) och betalar mot payment-mock, ända fram till att
  biljetten med QR-kod syns under "Mina biljetter". **Overifierat:** jag har inte
  kunnat köra detta steget mot en riktig Auth0-tenant under utvecklingen — CI:s
  första riktiga körning är det faktiska testet av inloggnings-automatiseringen
  (se `tests/e2e/specs/booking-flow.spec.ts`s header-kommentar). Kräver de nya
  secrets `AUTH0_WEB_CLIENT_ID`, `AUTH0_TEST_USER_EMAIL`, `AUTH0_TEST_USER_PASSWORD`
  (docs/runbook.md). `createRequireAuth0User` saknar fortfarande ett separat
  HTTP-lagerenhetstest (docs/plan.md Fas 3 "kända luckor") — e2e-sviten täcker nu
  vägen, men inte den isolerade kontraktstesten.
- ~~`eslint-plugin-boundaries` körs inte som CI faktiskt startar den~~ — **löst**:
  `boundaries/root-path` i `eslint.config.js` saknade en ABSOLUT sökväg och
  defaultade därför till `process.cwd()` vid lint-tillfället — `services/*/src/
  controllers/**` m.fl. matchade aldrig när varje paket körde sitt eget
  `eslint .` (det CI faktiskt gör via `turbo run lint`). Satt till
  `import.meta.dirname`. `scripts/verify-boundaries-enforcement.mjs` testar nu
  BÅDA fallen (cwd=repo-rot och cwd=paketkatalog) så regressionen inte kan
  smyga tillbaka obemärkt.

**Flyttat till efter inlämningen:** scanner-appen (Expo) · proof of work + Turnstile ·
PostHog + session replay · ArgoCD + Sealed Secrets · Tempo-backend · DLQ med adminvy ·
point-in-time recovery · hcloud cluster-autoscaler · AI-kundtjänst.

**Om tiden ändå tryter skärs i denna ordning:** offline-biljetter i PWA:n → arenakartans
sektionszoom (visa alla platser direkt) → väntelistan. Allt markerat **G** eller **VG**
rörs sist.

---

## Att ordna parallellt med fas 1

1. ~~Lärarens godkännande för soloprojekt~~ — **klart**
2. **Domän** — köp tidigt, DNS-propagering vill man inte vänta på i fas 1
3. **Konton** — Hetzner (kortverifiering kan ta en dag), Cloudflare (**API-token för
   DNS-01**), Auth0, Slack-webhook. Kolla GitHub Student Developer Pack först
4. **Auth0 M2M-kvot** — verifiera den innan scanner-fasen. Scannern måste **cacha sin
   token**, inte hämta en ny per skanning

---

## Demomanus för det muntliga försvaret

1. **Appen:** välj evenemang → väntrum med live köplats → karta → välj stolar →
   reservation med nedräkning → betalning → bekräftelse → QR-kod
2. **En merge:** push till main → pipeline → tester → image → **migrations-Job** → deploy →
   rollout. *(Pipelinen tar 10–20 min — ha något att prata om, eller visa en tidigare körning.)*
3. **Grafana:** RED-paneler, affärsmått, per-shard-vyer, `oversell_prevented_total`,
   **cache hit ratio vid kanten**
4. **Starta lasttestet:** `normal-sale` — 50 000 bokningsförsök över 15 min
5. **Under lasten:** booking-api skalar 2 → 10 i en gradvis kurva; KEDA skalar
   notification-worker på ködjup
6. **Under lasten: deploya booking-api** → visa noll misslyckade requests
7. Kön töms → poddarna skalar ner igen *(booking-api — gatewayen lovar ingen nedskalning)*
8. **Döda shard-1 live** (poddnivå — `kubectl delete pod`, ALDRIG en hel nod: Cloudflare
   Free gör inga origin-healthchecks, så en död nod hade fått ~halva trafiken att fortsätta
   gå dit och få 5xx tills `terraform apply` kört) → evenemang på shard-0 fortsätter fungera,
   och podden schemaläggs om på en annan nod tack vare nätverksvolymerna
9. **Trigga ett larm** → visa att det landar i Slack
10. Visa återställningsövningen och dess tidtagning, och **RPO/RTO som medvetet val**
