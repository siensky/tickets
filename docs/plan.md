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
| `deploy-under-load` | egen profil: 10 försök/s i 5 min, 0 fel krävs, `rollout restart` ×2 under körningen (7.3) |
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
| **6** | 2–3/11 | HPA (**requests 250m**) + KEDA, `scaleDown` 60 s. Zero-downtime: probes, `maxUnavailable: 0`, preStop, graceful shutdown, **`Recreate` på scheduler-worker**. k6-scenarier, lastgeneratorer, fd-gränser. **Mät HPA-kurvan, sedan den stora körningen.** ~~**Notering från Fas 4-review:** `RabbitMQQueueDepthHigh`-larmets tröskel (900, `infra/k8s/base/monitoring/prometheusrule.yaml`) antar redan KEDAs planerade tak...~~ — **dubbelkollad**: `ScaledObject`:en (`infra/k8s/base/notification-worker/scaledobject.yaml`) är byggd med exakt 100 meddelanden/podd × max 10 poddar = 1000, så 900 stämmer fortfarande. ~~**Noteringar från Fas 3-review, innan `queue-storm`:** (1) `realtime-gateway` ger varje WS-klient sin egen duplicerade Redis-anslutning...~~ — **löst**: (1) EN delad `psubscribe ws:*`-anslutning per podd (`shared/redis/src/pubsub.ts`s `subscribeToChannelPrefix` + `services/realtime-gateway/src/services/ws-subscriber-registry.ts`), varje WS-anslutning registrerar sig lokalt (synkront, inget eget Redis-anrop) mot sin kötoken-id. (2) `admitNextBatch` (`shared/redis/src/waiting-room.ts`) hoppar nu över redan utgångna ZSET-poster (jämfört mot ankomsttid + `queue_session_total_minutes`) i stället för att markera dem insläppta, och fortsätter poppa efter fler levande poster i samma tick — scheduler-worker läser nu åter `queue_session_total_minutes` (queue-config-repository.ts). **Tillagt efter Fas 5-granskning, på uttrycklig begäran — INTE ett betygskrav, körs här ändå:** UI/styling-ombyggnad av PWA:n (hittills helt ostylad HTML, se "Fas 5 — kända luckor"). Ny startsida à la Ticketmaster — landningssida med utvalda konserter/evenemang + utfyllnadsinnehåll, mobile first. Navbar med kategorier (musik, sport, teater, festivaler), sökfält, inloggningsknapp. Bläddring per kategori, "köp biljetter"-knapp per evenemang leder in i det redan byggda bokningsflödet (Fas 5: väntrum → arenakarta → reservation → checkout). Färgschema röd/vit/svart + blå accent — proffsigt, "clean", dyr känsla, inte en lekstuga. **Inte bara styling:** kategori/sök kräver en ny `category`-kolumn på `events` (migration) och att `GET /events` stödjer filtrering — events är shard-partitionerat på sitt eget `id`, så en sökning över kategori blir scatter-gather över båda shards, samma princip som `GET /me/tickets` redan använder (`services/booking-api/src/services/my-tickets-service.ts`), inte en enkel `WHERE`-rad på en databas. | **Klar efter review** (se nedan) — VG |
| — | **4/11** | **MUNTLIGT FÖRSVAR** | |
| **7** | 29/10–8/11 | Startad direkt efter Fas 6 (i stället för 5/11). `architecture.md`, ADR:er, `runbook.md` med **RPO/RTO**, README med adresser — PLUS Loki-fix, zero-downtime-bevis, Grafana-demopaneler, återställningsövning, CSV-seed med bilder, PostHog, biljettscanner (webbapp), Pact-kontraktstester, snabbare CI, UI/styling. Se **"Fas 7 — detaljplan"** nedan. | **Inlämning 8/11** |

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
  **Ny lucka hittad EFTER första riktiga deployen:** att ladda upp filerna till R2
  kopplar ingenting till domänen — `<domän>` hade ingen DNS-post alls
  (`ERR_NAME_NOT_RESOLVED`). En vanlig R2 "Custom Domain" hade dessutom gjort HELA
  den delade bucketen publik, inklusive backuperna — ett säkerhetsproblem, inte bara
  en smaksak. **Löst:** `infra/terraform/cloudflare-frontend.tf`, en liten Cloudflare
  Worker (`infra/terraform/workers/frontend-proxy.js`) som läser bucketen via sin
  egen R2-binding (aldrig publik åtkomst) och faller tillbaka till `index.html` för
  klientsidig routing (`cloudflare_workers_custom_domain` skapar DNS-posten åt
  apex). Se docs/runbook.md "Frontend-proxy-Workern" för engångsstegen (ny
  behörighet på Terraforms Cloudflare-token + två nya variabler).
  ~~Ny lucka hittad i samma arbete: `realtime-gateway` har fortfarande ingen
  ingress~~ — **falskt larm, upptäckt i Fas 6-reviewn**: `infra/k8s/base/
  realtime-gateway/` har visserligen ingen egen `ingress.yaml`, men routningen
  dit finns redan sedan Fas 3 — `infra/k8s/base/booking-api/ingress.yaml`
  routar `/ws` till `realtime-gateway` på SAMMA host (`api.tikknet.se`),
  matchar planens egen "Trafikväg" (ingen egen WS-subdomän). `wss://
  api.tikknet.se` i `deploy-frontend` fungerar alltså redan.
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

**Fas 6 — kända luckor kvar efter reviewn** (flaggas hellre än göms, samma princip som
Fas 3/5):

- **Hela lasttest-infrastrukturen (Terraform, k6-scripten, rapport-/
  reset-skripten) är byggd men ALDRIG körd mot ett riktigt kluster** —
  samma gräns som Fas 4:s observability-infra (`infra/terraform/
  observability.tf` m.fl.), ingen Tailscale-åtkomst i byggmiljön, och
  ingen k6-binär fanns att testa mot ens lokalt. `tests/load/queue-storm.js`s
  WebSocket-anslutning (`k6/ws`) är särskilt overifierad — smoke-testa
  den specifikt med få VU innan en riktig körning.
- **HPA-kurvan** (docs/plan.md "Autoscaling": "Mät kurvan i Fas 6 före
  den stora körningen") är alltså heller inte uppmätt än — Grafana-
  panelen för den finns nu ("Autoscaling & lasttest"-dashboarden,
  `infra/k8s/base/monitoring/dashboards.yaml`, tillagd EFTER den
  initiala Fas 6-leveransen på uttrycklig begäran), men ingenting har
  faktiskt synts i den än.
- **De fyra affärsmåtten ("aktiva reservationer, insläppstakt, sålda
  biljetter, konverteringsgrad") finns nu i koden** (`shared/
  observability/src/metrics.ts`s `createBusinessMetrics`, se
  docs/phase-status.md) — löst samtidigt som Grafana-utbyggnaden, inte
  i den ursprungliga Fas 6-leveransen.
- **`queue_admission_rate_per_minute` måste höjas live** innan
  `normal-sale`/`spike-sale` körs på riktigt (se kommentaren i
  tests/load/normal-sale.js) — annars ackumuleras en obegränsad kö.
  Inget skript gör detta automatiskt; ett medvetet val (samma anda som
  reset-sale.ts: ingen automatisk körning av något som kan snedvrida
  nästa körning).
- **realtime-gatewayens minnesrequest (320Mi, upp från 256Mi) och
  HPA-tröskeln är en ouppmätt uppskattning** (deployment.yaml/hpa.yaml)
  — mät faktisk RSS i vila vid första riktiga deploy.
- **CSV-biljettimporten (se "Import av biljettnummer (CSV)" ovan) är nu
  byggd** — `services/scheduler-worker/src/scripts/import-tickets.ts`,
  byggd på en EGEN liten gren efter Fas 6, inte en del av den
  ursprungliga leveransen. Två antaganden som INTE ges av uppgiften
  (bekräftat med användaren att den riktiga filens format är okänt):
  (1) CSV:n antas vara EN kolumn (`ticket_number` per rad), utan
  sektion/rad/plats — paras ihop positionellt mot venuets befintliga
  `venue_seats` i en fixerad ordning. Anger den riktiga filen i stället
  sektion/rad/plats per biljettnummer måste ihopparningen bytas ut. (2)
  Inget skript seedar ännu den "riktiga" venuens 5 000 `venue_seats`
  själv (bara 30-sätes demo-venuen i seed-demo-events.ts) — det är ett
  separat, ännu obyggt steg före importen kan köras mot ett riktigt
  event.

### Fas 7 — detaljplan (planerad 29/10)

Lärdomarna från lasttestet ligger i `infra/LASTTEST-NOTES.md`. **Byggs i exakt den
ordning som står i 7.16**, med de gemensamma reglerna i 7.18. 7.1–7.19 beskriver *vad*
som byggs. Försvaret är 4/11 och inlämningen 8/11. Om tiden inte räcker skärs steg från
*slutet* av 7.16, aldrig något G/VG-steg (markerade i 7.16).

**7.1 Lasttest-ändringar: permanenta vs. växlade.** *Permanent i git* (så nästa lasttest
fungerar direkt och systemet tål hög trafik när som helst):
- RabbitMQ 1500m CPU / 768Mi + `fix-cookie-perms`-initContainern
  (`infra/k8s/base/rabbitmq/statefulset.yaml` — filen säger 1000m, live kör 1500m).
- ingress-nginx 1000m/512Mi (`infra/terraform/helm.tf`, redan i filen — appliceras via
  Terraform så state matchar live-patchen).
- payment-mock 500m CPU-gräns (`infra/k8s/base/payment-mock/deployment.yaml`).
- cloud-init-buggen permanent fixad. Exakt orsak är **inte** bevisad. Loggen visar att
  `/root/.gnupg` saknades och att dirmngr inte gick att nå, trots att paketet `dirmngr`
  var installerat. Samma kommandon fungerade manuellt över SSH. Fixen tar därför bort
  beroendet istället för att gissa:
  1. `export GNUPGHOME=$(mktemp -d)` + `chmod 700` före gpg.
  2. `gpgconf --launch dirmngr`.
  3. Nyckelimporten i en retry-loop (5 försök, 5 s mellan).
  4. Sist `command -v k6 || exit 1`, så att `cloud-init status` blir `error` om k6
     saknas, istället för tyst.

  Verifieras genom att skapa en ny loadgen-VM och se `k6 version` utan manuella steg.
  Faller det ändå finns den manuella kommandoraden kvar i `infra/LASTTEST-NOTES.md`.

*Medvetet INTE permanent* — växlas av ett nytt script, `scripts/loadtest-mode.sh on|off`,
så inget manuellt steg kan glömmas:
- Rate limiter-allowlistan: loadgen-IP:erna lämnas tillbaka till Hetzner när VM:erna rivs
  och kan hamna hos någon annan kund — den skulle då kringgå vårt botskydd.
- `STRIPE_HOST`/`STRIPE_PORT`/`STRIPE_WEBHOOK_SECRET` → payment-mock: produktion kör
  riktigt Stripe-testläge (demon visar riktig Stripe Checkout). payment-mock finns för att
  inte skicka 50 000 försök till Stripe.
- `queue_admission_rate_per_minute`: väntrummet ska strypa insläppet. Hög trafik klaras
  genom att folk köar, inte genom högt insläpp. Defaulten 300 är ingen kraschrisk.
- payment-mock-repliker (4 under test, 1 annars) och loadgen-VM:erna (kostnad,
  `loadgen_node_count` tillbaka till 0).

`on` läser `terraform output loadgen_ipv4s`, sätter allt ovan och skriver ut
smoke-kommandot + DB-kontrollen (ordrar ska bli `paid`). `off` återställer genom att
ta bort överskrivningarna med `kubectl set env … STRIPE_HOST- STRIPE_PORT-
RATE_LIMIT_ALLOWLISTED_IPS-` och ersätta `STRIPE_WEBHOOK_SECRET`-posten med dess
secretKeyRef via en JSON-patch (`op: replace` på env-indexet, hittat med `jq`). **Inte**
`kubectl set env --from=secret/…`: det namnger variabeln efter nyckeln. Den applicerar
*inte* base-filen direkt: den har `image: …:latest` (CI sätter den pinnade taggen via
kustomize). **Verifierat 29/10:** lämnas en överskrivning med ett literalt värde kvar
failar CI:s `k8s-dry-run` (och därmed deployen) med "valueFrom may not be specified when
`value` is not empty". `loadtest-mode off` ska därför avslutas med samma dry-run.
Dokumenteras i runbooken.

**7.2 Loki-fix (G-krav: logging).** Orsak: Loki-chartet har `auth_enabled: true` som
default (multi-tenant), Alloy skickar ingen `X-Scope-OrgID` → 401 på varje loggbatch,
noll loggar sparade. Vi har en tenant, så: `loki.auth_enabled = false` i
`helm_release.loki` (`infra/terraform/observability.tf`). Ingen ändring i Alloy eller i
Grafanas datakälla. Applicera med `terraform apply -target=helm_release.loki -target=helm_release.alloy`
(Alloy behöver en ServiceMonitor, `alloy.serviceMonitor.enabled`, annars skrapas dess mått inte och larmet nedan
kan aldrig utlösas).
Verifiering: (1) inga nya 401 i Alloys logg, (2) Grafana Explore `{namespace="ticketing"}`
visar rader, (3) Lokis labels-API returnerar `namespace`/`pod`. Plus ett larm i
`prometheusrule.yaml` på Alloys dropped-entries-mått (exakt namn verifieras i Alloys
`/metrics`), så tyst loggförlust inte kan hända igen.

**7.3 Bevis för deploy utan nertid (VG).** Konfigurationen finns redan (de fyra punkterna
under "Zero-downtime"). Det som saknas är mätningen, och den planerade mätningen kan inte
lyckas: `deploy-under-load.js` återanvänder normal-sale-profilen, som gav 13,6 %
`http_req_failed` redan *utan* deploy (överlast, och 409 räknas som fel). Ny design:
- Egen profil i `deploy-under-load.js`: `constant-arrival-rate` 10 iterationer/s
  (långt under taket) i 5 min, mot lasttest-eventet direkt efter `reset-sale`, med
  `loadtest-mode on`. Att eventet säljer slut under körningen är okej: 409 räknas som
  korrekt svar (nästa punkt).
- `http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 409))` —
  "stolen redan tagen" är ett korrekt svar, inte ett fel.
- Threshold `http_req_failed: ['rate==0']`: k6 blir röd vid ett enda misslyckat request.
- Under körningen: en riktig merge genom pipelinen (bäst demo), alternativt
  `kubectl rollout restart deployment/booking-api` två gånger.
- Mät på två ställen: k6 (klienten) och ingress-nginx 5xx (servern). Kräver att
  ingress-nginx-metrics slås på (`controller.metrics.enabled` + ServiceMonitor i
  `helm.tf`) — idag finns inga ingress-mått alls.
- Känd risk: loadtest-hosten går via DNS round-robin direkt mot nod-IP:erna utan
  hälsokontroll. Startas en nods ingress-pod om under testet får klienter "connection
  refused" (hände under spike-sale). En booking-api-rollout rör inte ingress-poddarna,
  men ingress får inte startas om under mätningen.
- Resultatet (k6-summary + Grafana-skärmdump) sparas i `docs/evidence/zero-downtime.md`.

**7.4 Grafana för försvaret.** Dashboarden "Autoscaling & lasttest" finns redan (repliker
över tid, HPA aktuellt mot min/max, CPU per podd mot målet, nod-CPU/minne, omstarter).
Lägg till:
- **Demo-rad:** EN panel med repliker + request rate + CPU % av målet på samma tidsaxel —
  "last upp → poddar upp → last ner → poddar ner efter 300 s" i en bild.
- **Zero-downtime-rad:** ingress-5xx/s, booking-apis ready-repliker och request rate.
- **Deploy-annotationer** från `changes(kube_deployment_status_observed_generation{deployment="booking-api"}[1m]) > 0`.
- Verifiera att alla befintliga paneler faktiskt visar data. Prometheus-sidan har
  aldrig kontrollerats i Grafana.

Allt som JSON i `infra/k8s/base/monitoring/dashboards.yaml`, som idag.

**7.5 Återställningsövning.** Hämta senaste nattliga dumpen från R2, återställ i en
tillfällig Postgres-pod (inte prod), verifiera (antal events/ordrar/biljetter +
kronjuvel-queryn), ta tid på varje steg. Fyll i RPO (hur gammal dumpen är — upp till 24 h)
och RTO (hur lång tid återställningen tar) i `runbook.md`, där det idag står "ej körd än".

**7.6 Seed: CSV-styrda events med bilder.** Ersätter `seed-demo-events.ts`.
*Beslut (29/10):* 20 events, 5 per kategori, påhittade artister, bilder från Unsplash
(fri licens). Små och stora arenor.
- `seed/venues.csv`: venue, city, section, rows, seats_per_row. Förslag: 3 små arenor
  (en sektion, 60–200 platser — hela kartan visas direkt) och 2 stora (4–8 sektioner,
  1 500–3 000 platser — sektionsvyn, enligt "Webbappens tekniska val").
- `seed/events.csv` (datum i ISO 8601 med tidszon, t.ex. `2026-12-05T19:30:00+01:00`;
  alla 20 får `sales_open_at` i det förflutna så de är bokningsbara): slug, title,
  artist, category, venue, starts_at, sales_open_at, sales_close_at, price_sek, featured (true/false — 4 st `true` till startsidans hero),
  image, description. Priset kan överstyras per sektion i en valfri kolumn
  `section_prices` (`Parkett:695;Läktare:395`), annars gäller `price_sek` för alla
  stolar. Layoutkolumnerna (E3) ligger i `seed/venues.csv`.
- Scriptet validerar hela CSV:n innan något skrivs (okänd venue, fel datumformat, saknad
  bild i `seed/images/`) och avbryter med radnummer. Allt eller inget.
- Lasttestets 5 000-platsersarena och event lämnas orörda.
- Nytt idempotent script `seed-events-from-csv.ts` i scheduler-worker: id härledda från
  slug, varje event skrivs bara till sin egen shard (samma regler som dagens seed-script).
- Ny kolumn `events.image_url` (migration). Inget nytt S3 behövs: R2 är redan
  S3-kompatibelt och serverar frontenden. Bilderna ligger i `seed/images/`, laddas upp
  till R2 under `images/` i `deploy-frontend` (uppladdningssteget byggs här i steg 6, inte
  i 1c) och serveras från `cdn.tikknet.se` (7.19).
  Format WebP, 1600×900, ≤250 kB styck.
- Körs manuellt mot prod (port-forward, som reset-sale) och dokumenteras i runbooken.

**7.7 PostHog — produktanalys.** Inte betygsgrundande (CV).
- *Arkitektur:* `shared/analytics` = typad händelsekatalog (namn + props-typer), den
  enda källan. Wrappern `track(name, props)` gör ingenting utan nyckel (lokalt, CI,
  tester). `apps/web` använder `posthog-js` + `PostHogProvider` och
  `capture_pageview: 'history_change'` (SPA). Servern använder `posthog-node` i
  booking-api och scheduler-worker, med `shutdown()` i graceful shutdown så inga
  händelser tappas vid deploy.
- *Region och adblock:* EU-molnet. Reverse proxy i den befintliga apex-Workern
  (`infra/terraform/workers/frontend-proxy.js`), enligt PostHogs proxy-guide:
  - `/ingest/static/*` → `eu-assets.i.posthog.com`
  - övriga `/ingest/*` → `eu.i.posthog.com`

  `posthog.init({ api_host: '/ingest', ui_host: 'https://eu.posthog.com' })`. Utan proxy
  blockerar adblockers en stor andel av händelserna. Workern får aldrig skicka vidare
  andra sökvägar (test i 7.19-stil).
- *Identitet:* `distinct_id` = Auth0 `sub` (ett opakt id, ingen PII) på **båda** sidor.
  Klienten anropar `posthog.identify(sub)` efter inloggning och `reset()` vid
  utloggning. Servern känner bara `orders.user_id`, så den slår upp `users.auth0_sub`
  (global-poolen) innan den skickar. Tratten går då ihop även när sista steget skickas av
  servern. Klienten känner inte till det interna user-id:t och ska inte göra det. Aldrig
  e-post, namn, kortdata eller QR-token.
- *Klienthändelser:* `event_viewed`, `search_performed`, `category_filtered`,
  `queue_joined`, `queue_admitted {wait_seconds}`, `queue_left {wait_seconds}` (lämnade
  innan insläpp), `seats_selected {seat_count}`, `reservation_created {seat_count}`,
  `checkout_started {total_sek}`, `checkout_returned {status}`, `ticket_viewed`.
  Gemensamma props: `event_id`, `category`.
- *Serverhändelser:*
  - `payment_succeeded {order_id, event_id, seat_count, total_sek}` och
    `payment_late_refunded`: från payment consumer, med köparens `sub` som
    `distinct_id`, så de hamnar i tratten. Kan inte blockeras av en adblocker.
  - `reservation_expired` (scheduler-worker): reservationen hör till en anonym kötoken
    (inloggning sker först vid checkout). Skickas därför som personlös händelse
    (`$process_person_profile: false`, `distinct_id` = kötoken-id). Den syns i
    trend-grafen "Reservationer som löper ut", inte i tratten.
  - `ticket_scanned {result, gate}` (E7): personlös, `distinct_id` = staff-`sub`.
- *Feature flag:* en flagga med mätbar effekt på `event_viewed → queue_joined`
  (BESLUT, se nedan).
- *PostHog-dashboard:* "Bokningstratt" (7 steg, uppdelad per kategori), "Kö-avhopp",
  "Reservationer som löper ut".
- *Lasttest:* `POSTHOG_ENABLED=false` på servern under `loadtest-mode on`, annars blir
  analysdatan full av k6-trafik.
- *Nycklar:* `VITE_POSTHOG_KEY` (publik projektnyckel, byggs in i frontenden — inte
  hemlig) och `POSTHOG_KEY` i `tickets-app-secrets` via GitHub-secret.
- *Garanti att det fungerar:* (1) `tsc` stoppar fel props, unit-test att wrappern
  no-op:ar utan nyckel; (2) Playwright fångar anropen till `/ingest` och kontrollerar att
  `queue_joined`, `reservation_created` och `checkout_started` skickas i bokningsflödet;
  (3) integrationstest i booking-api med mockad `posthog-node`: `payment_succeeded`
  skickas exakt en gång, även vid dubbel webhook; (4) `curl` mot `/ingest` via proxyn;
  (5) manuellt: en riktig bokning i prod syns i PostHogs "Live events" och i tratten.
- *Beslut (29/10):* **samtycke** — cookieless (`persistence: 'memory'`) tills
  användaren godkänner i en banner, därefter `localStorage+cookie` (`opt_in_capturing`).
  Nej = fortsatt cookieless, ingen `identify`. Bannern förklarar i en mening vad som
  samlas in ("anonym statistik om hur bokningsflödet används, ingen
  personinformation"). Valet sparas i `localStorage` och kan ändras via en länk i
  navbarens användarmeny. **Session replay av.**
  **Feature flag** `show_seats_left_badge`: "X platser kvar" på eventkorten, mäts mot
  `event_viewed → queue_joined`. Flaggan utvärderas **bara efter samtycke**. Utan
  samtycke byts det anonyma id:t vid varje sidladdning, så varianten skulle hoppa
  mellan sidladdningar. De användarna ser default (ingen badge) och ingår inte i
  experimentet. Tratten för användare utan samtycke går därför inte att koppla ihop med
  serverns händelser, vilket är ett medvetet integritetsval. PostHog-kontot (EU) skapar
  användaren själv.

**7.8 Biljettscanner — `scan.tikknet.se`.** *Avviker från planen* (Expo-app + M2M-
inloggning): en webbapp på egen subdomän, där anställda loggar in med vanlig
Auth0-inloggning och rollen `staff`. Motivering: kameran fungerar i mobilwebbläsare över
HTTPS, samma stack och pipeline som `apps/web`, ingen app store.
- `apps/scanner`: Vite + React + TypeScript + Tailwind/daisyUI med samma `tikknet`-tema
  och logga som `apps/web` (temat flyttas till ett delat CSS-paket,
  `shared/ui-theme/theme.css`, som båda apparna importerar). QR-läsning med
  `@zxing/browser` (bakre kameran, `facingMode: 'environment'`). Ingen PWA, ingen offline.
- **Viktigt om QR-koden** (analyserat 29/10): QR-koden innehåller bara `qr_token`, en
  HMAC-SHA256 av `orderId:seatId` (`services/booking-api/src/services/qr-token.ts`). Den
  går inte att avkoda till ett biljett-id. Formatet ändras *inte* (redan utfärdade
  biljetter måste fortsätta fungera). Uppslaget görs i stället på `tickets.qr_token` inom
  det valda eventets shard. Därför går "fel event" inte att skilja från "ogiltig": båda
  ger resultatet `not_found` ("Biljetten gäller inte detta event eller är ogiltig").
- Auth0: ny SPA-applikation "Scanner" (egna callback-URL:er för `https://scan.tikknet.se`
  och `http://localhost:5174`). På API:t: RBAC på + "Add Permissions in the Access
  Token" på. Permission `scan:tickets`, roll `staff` med den permissionen. Anställda
  skapas manuellt i Auth0 och får rollen. Exakta steg i 7.17.
- booking-api: `POST /scans`. Exakt byggplan i **E7 (7.13)**.
- UI-flöde: logga in → om token saknar `scan:tickets`: "Ditt konto har inte
  scannerbehörighet" + logga ut → välj event (från befintliga `GET /events`) → välj grind
  (fast lista `Grind A`–`Grind D` i `apps/scanner/src/config.ts`) → kameravy. Resultat i
  helskärm i 2,5 s, sedan tillbaka till kameran:
  - **Grönt** `ok`: eventnamn + sektion/rad/stol.
  - **Rött** `already_scanned`: "Redan skannad 19:42 vid Grind B".
  - **Rött** `not_found` / `refunded` / `void`: förklarande text.

  Samma kod skannas inte om inom 3 s (debounce). Nekas kameran visas en instruktion för
  att tillåta den.
- *Beslut (29/10):* ingen offline-kö (kräver nät). Alla med rollen `staff` får skanna
  alla events. Ingen manuell inmatning (biljettnummer visas inte för köparen, så det
  finns inget att mata in).
- Deploy: byggs i CI (`deploy-frontend`-jobbet utökas) → R2-prefix `scanner/` → en
  Cloudflare Worker-route för `scan.tikknet.se` i Terraform
  (`infra/terraform/cloudflare-frontend.tf`, samma mönster som apex: läser prefixet
  `scanner/`, faller tillbaka till `scanner/index.html`). CORS: se E7.
- Tester: unit (resultatvyerna, debounce), integration och system (E7 + 7.14 F7), e2e
  (köp → skanna med injicerad QR-sträng → andra skanningen avvisas; kameran mockas i
  Playwright med en fake media stream), Pact (7.9).

**7.9 Kontraktstester (Pact).** Pact JS, consumer-driven, **ingen broker**: monorepo, så
konsumenttesterna skriver pact-filer till `pacts/` och providern verifierar dem i samma
CI-körning. Provider-states seedas med Testcontainers, som i integrationstesterna.
Kontrakt:
1. `web → booking-api`: `GET /events`, `GET /events/:id`, sektionssammanfattning (E2),
   stolstatus (E4), `POST` reservation, `GET` reservation (E5), `POST` checkout,
   orderstatus (E6), `GET /me/tickets`.
2. `scanner → booking-api`: `POST /scans`.
3. `payment-mock → booking-api`: webhooken `POST /webhooks/stripe` (payload + headerformat).
4. Message pacts: booking-api → notification-worker (order-event via RabbitMQ), och
   booking-api/scheduler-worker → realtime-gateway (Redis `ws:*`).

Ärligt för försvaret: dagens webhook-401 (fel secret) hade Pact *inte* fångat. Det är
driftkonfiguration, inte kontraktsform. Det fångas av `loadtest-mode`s paid-kontroll.

**7.10 Snabbare CI (8–17 min idag).**
- e2e-variansen: själva sviten tar ~10 s. Steget "Install Playwright's browser" tar
  allt från 22 s till 9 min, eftersom Chromium + apt-paket laddas ner utan cache varje
  gång. Fix: cacha `~/.cache/ms-playwright` på Playwright-versionen (kör bara
  `install-deps` vid cache-träff), eller kör jobbet i `mcr.microsoft.com/playwright`-
  containern.
- build-and-push: de 6 imagesen byggs i sekvens i ett jobb (~4–5 min). En matrix bygger
  dem parallellt (~1–1,5 min). Förväntat totalt: ~5–6 min.
- *Verifiering:* matrisen körs bara vid push till `main` (ci.yml bygger inga images), så
  grön CI räcker inte. Granska första deploy-körningen efter merge: alla sex benen gröna,
  `deploy` fick rätt SHA. Den körningen går utan cache (nya scope-namn), så mät tiden på
  den **andra** körningen mot `main`.

**7.11 UI/styling — designsystem och bokningsflöde.** Skriver inte om befintlig logik:
hookarna (`use-queue-admission`, `use-queue-socket`, `use-seat-marking`), `api-client.ts`
och TanStack Query-mönstret behålls. Sidorna byggs om ovanpå dem.

*Utgångsläge (analyserat 29/10):* Tailwind 4 utan Preflight (medvetet, se
`globals.css`) och egna tokens. Bara startsida och navbar är stylade. `SeatGrid` är redan
SVG med färgkodade cirklar (bara färg skiljer statusarna). Sektionsväljaren är en lista
utan karta. Sektioner saknar geometri, och stolstatus saknar pris. Kön ger
`position` + `queueDepth`, ingen väntetid. Reservationen ger bara `seatIds`.
`CheckoutSuccessPage` verifierar *inte* betalningen. Avgifter finns inte i backend.

*Designriktning — temautvärdering* (WCAG-kontrast uträknad från daisyUI 5.7:s
OKLCH-värden):

| | Brödtext mot bakgrund | Primärknapp (text/knapp) | Primärfärg som text | Intryck |
|---|---|---|---|---|
| valentine | 5,5 (rosa text på rosa) | **3,7 — underkänt AA** | 3,4 | romantisk, lekfull; rosa bas känns inte tryggt vid betalning |
| nord | 10,8 | 5,0 | 3,5 | trygg och lugn men grå-blå, generisk |
| cupcake | 15,9 | 5,2 | **1,4 — oanvändbar** | pastell, för lekfull |

**Beslut (rekommenderat):** eget daisyUI-tema `tikknet`. Det har nords neutrala,
högkontrastiga struktur, men primärfärgen är en djup ros-röd i valentines nyans
(mörkad så vit text klarar AA). Det matchar planens "röd/vit/svart + blå accent" och
känns inte som en generisk SaaS-app:

| Token | Värde | Kontrast |
|---|---|---|
| base-100 / 200 / 300 | `oklch(98.5% .003 260)` / `oklch(96% .006 260)` / `oklch(91% .01 260)` | — |
| base-content (ink) | `oklch(22% .02 265)` | 16,6 |
| muted text | `oklch(50% .02 265)` | 5,8 |
| primary | `oklch(52% .21 12)`, content vit | 6,1 (vit text), 5,9 som text |
| accent (länkar, egen vald stol) | `oklch(50% .18 258)` | 5,9 |
| neutral | = ink | — |
| success | `oklch(55% .15 150)` | 4,3 (grafik ≥3 ok, text använder `success-content`) |
| warning | `oklch(62% .15 65)` | 3,6 (bara grafik) |
| error | `oklch(52% .2 27)` | verifieras ≥4,5 i kontrasttestet |

*Beslut (29/10):* temat `tikknet` godkänt. **Bara ljust tema, inget mörkt läge och ingen
temaväxlare.** **Ingen footer** — allt navigerbart ligger i navbaren. **Logga:**
ordmärket "tikknet" i Plus Jakarta Sans ExtraBold, där pricken över i:et är en lutad
biljett i primärfärgen. Texten är konverterad till vektorformer, så loggan är oberoende
av fontladdning. Filer: `apps/web/public/brand/tikknet-logo.svg` (mörk text),
`tikknet-logo-white.svg` (för mörk/bildbakgrund) och `tikknet-icon.svg` (biljetten på
mörk rundad ruta → favicon och PWA-ikoner, ersätter dagens ikoner i `vite.config.ts`s
manifest). PWA-manifest och iOS kräver PNG. Därför genereras `pwa-192x192.png`,
`pwa-512x512.png`, `maskable-512x512.png` (ikonen med 20 % säkerhetsmarginal) och
`apple-touch-icon-180x180.png` från SVG:n med `@vite-pwa/assets-generator` (dev-beroende)
och committas. `favicon.svg` används direkt. Färger: ink `#161b24`, primär `#c30048` (= `oklch(52% .21 12)`).
**Avgifter:** ingen avgiftsrad visas. Plattformen tar ingen serviceavgift ovanpå
biljettpriset, och backend har inget avgiftsbegrepp.

*Tokens:*
- **Radier:** `--radius-box: .75rem` (kort, paneler), `--radius-field: .5rem` (knappar,
  fält), `--radius-selector: .375rem`. Piller (`rounded-full`) bara för badges och chips.
- **Kanter/djup:** `--border: 1px`, `--depth: 0`. Skuggor: kort `shadow-sm` → hover
  `shadow-md` + `-translate-y-0.5`, sticky bokningspanel `shadow-lg`, inget annat.
- **Typografi (beslutat):** brödtext och UI i Inter Variable, rubriker (display, h1–h3)
  och ordmärket i Plus Jakarta Sans 700/800. Båda självhostade via
  `@fontsource-variable/inter` och `@fontsource-variable/plus-jakarta-sans` (ingen
  Google-CDN — GDPR + PWA offline). Skala: display 2.5rem→3.75rem (lg) / 1.05 / 800 /
  tracking -0.02em · h1 2.25rem/700 · h2 1.5rem/700 · h3 1.125rem/600 · body 1rem/1.6 ·
  small .875rem · etikett .75rem versaler tracking-wide. Priser, tider och köposition
  med `tabular-nums`.
- **Spacing:** Tailwinds 4px-skala. Sidcontainer `max-w-7xl px-4 sm:px-6 lg:px-8`,
  sektioner `py-12 lg:py-16`, kortpadding `p-4 sm:p-5`, gap `4/6`.
- **Ikoner:** Lucide, stroke 1.75, storlek 16/20/24, alltid med synlig text eller
  `aria-label`.
- **Brytpunkter:** Tailwinds default (sm 640, md 768, lg 1024, xl 1280). Eventgrid
  1/2/3/4 kolumner vid bas/sm/lg/xl. Bokningspanelen sitter till höger från `lg`, under
  det som bottenpanel.
- **Komponentvarianter:** Button (primary · secondary = ink-outline · ghost · link;
  sm/md/lg; `loading` = spinner + `aria-busy` + disabled) · Badge (kategori; säljstatus
  `on_sale` / `few_left` / `sold_out` / `opens_soon`) · Alert (info/success/warning/error,
  med ikon + text, aldrig bara färg) · Card · Skeleton · EmptyState · ErrorState (med
  "Försök igen") · Modal (native `<dialog>`) · BottomSheet.
- **Rörelse:** bara CSS-transitions (150–200 ms). Allt av under
  `prefers-reduced-motion`.

*Stolstatus — aldrig bara färg* (planens färgsemantik behålls, plus form/symbol):

| Status | Utseende | aria-label |
|---|---|---|
| ledig | grön fylld cirkel | "Rad C, plats 12, 450 kr, ledig" |
| reserverad av annan | amber + diagonal randning (SVG-pattern) | "…, upptagen" |
| såld | grå, mindre cirkel med × | "…, såld" |
| egen vald | accentblå, större, ✓ + ring | "…, vald av dig" |

Legend alltid synlig ovanför kartan. Fokusring 2px accent + 2px offset.

*Bibliotek:*

| Bibliotek | Beslut | Varför |
|---|---|---|
| Tailwind 4 | ✅ finns | Preflight slås PÅ i samma leverans som alla sidor stylas om (annars går ostylade sidor sönder) |
| daisyUI 5 | ✅ nytt | Tema + CSS-komponenter, noll JS-runtime, `@plugin "daisyui"` i Tailwind 4 |
| shadcn/ui | ❌ | Dubblerar daisyUI (två komponent- och temasystem). Det enda JS-beteende som behövs (modal, fokusfälla) ger native `<dialog>` |
| lucide-react | ✅ nytt | Trädskakbara ikoner, en enhetlig stil |
| SVG för arenakartan | ✅ (finns) | Se nedan |
| React Konva | ❌ | Canvas = ingen DOM, ingen tillgänglighet (fokus, `aria-label`), svårare att testa, ~150 kB. Behövs först vid >10 000 samtidigt animerade stolar |
| react-zoom-pan-pinch | ✅ nytt | Pan/zoom/pinch över SVG utan egen gestkod (den mobila delen är svår att få rätt själv) |
| TanStack Query | ✅ finns | Oförändrat |
| React Hook Form + Zod | ❌ | Det finns inga riktiga formulär: kunduppgifter kommer från Auth0, kortet hos Stripe, sök är ett enda fält. Zod finns redan i backend (`shared/schemas`) |
| Motion | ❌ | De få animationerna klaras med CSS. Undviker ett beroende |
| sonner | ✅ nytt (beslutat) | Notiser med `aria-live` ("en av dina stolar togs", fel) |
| embla-carousel-react | ✅ nytt (beslutat) | Utvalda events på startsidan |
| @fontsource-variable/inter | ✅ nytt | Självhostat typsnitt |

**SVG mot Konva i detalj:** Den största sektionen i seed-arenorna (7.6) är några hundra
stolar, och vi ritar alltid *en* sektion i taget. Det är långt under där SVG blir långsamt.
SVG ger riktiga fokuserbara element, skalar skarpt vid zoom, temas med CSS och testas med
Testing Library och Playwright.

*Sidor och flöde* (routes oförändrade utom `/events/:id/queue`, som är ny):

- **A. Startsida.**
  - **Navbar:** ordmärket "tikknet", kategorilänkar, sök som sätter `?q=` mot
    befintliga `GET /events?q=`, "Mina biljetter", och logga in / avatar-meny. Mobil:
    hamburgare + drawer.
  - **Hero:** embla-karusell med 3–5 `featured`-events. Bild med gradient-overlay så att
    texten klarar ≥4,5. Visar titel, datum, arena och knappen "Köp biljetter".
    Autoplay av som default, pilar + prickar, tangentbordsstyrd.
  - **Innehåll:** kategorichips och ett grid med EventCards per vald kategori eller
    "Alla". Ingen footer.
  - **EventCard:** bild 16:9 (`loading="lazy"`, fast aspect ratio så layouten inte
    hoppar), datumblock, titel, artist, "arena · stad", "från 395 kr" (`minPriceCents`),
    säljstatus-badge (`availability` från backend, E1 i 7.13), och "X platser kvar"-badgen
    (`availableSeats`) bakom flaggan `show_seats_left_badge` (7.7). Saknar eventet bild
    (t.ex. lasttest-eventet) visas en gradient i primärfärgen med kategorins ikon.
- **B. Eventsida.**
  - **Hero:** bild, titel och artist.
  - **Infoblock:** datum + tid (`Intl`, `sv-SE`, Europe/Stockholm, t.ex. "fre 27 nov
    2026 · 20:00"), arena och stad, prisintervall, säljstatus. Om försäljningen inte har
    öppnat visas en nedräkning till öppning. Annars slutsålt eller stängt.
  - **Knapp:** "Boka biljetter" går till kön. På mobil är den sticky längst ner.
  - **Viktig info:** max 5 biljetter per köp, reservationen hålls i 5 min, biljetterna
    syns med QR-kod under Mina biljetter, och eventets beskrivning.
- **C. Kösida `/events/:id/queue`** (flyttar ut köhanteringen ur seatmap-sidan).
  Seatmap-sidans befintliga skydd behålls. Är användaren inte `admitted` skickas hen
  till `/events/:id/queue` i stället för dagens feltext. Bara
  `useQueueAdmission` avgör om användaren släpps in.
  - **Tillstånd:**
    - `joining`
    - `waiting`: "Du har plats **1 234** i kön" + "3 400 personer köar". Positionen läses
      upp via `aria-live="polite"` högst var 10:e sekund.
    - `admitted`: navigerar automatiskt till kartan, med en kort bekräftelse.
    - `sales_closed`
    - `not_found`: kötoken har gått ut. Knapp "Ställ dig i kön igen".
    - Anslutning tappad: banner "Återansluter…". Polling fortsätter, platsen behålls
      eftersom token är sparad. Text: "Stäng inte fliken".
  - **Ingen** väntetid (backend ger ingen tillförlitlig siffra), **ingen** progressbar.
    En lugn puls-animation (av vid reduced-motion) visar att sidan lever.
- **D. Arenakarta.** Steg 1 är **översikten**, en SVG med sektionerna utritade
  (`layout` från backend) och scenen markerad. Varje sektion visar lediga platser och
  prisintervall. Fyllnaden visar tillgänglighet med mönster: ledig, få kvar,
  slutsåld. Klick, Enter eller tapp öppnar sektionen. Saknar venuen `layout` (t.ex.
  lasttestarenan) visas sektionerna som ett rutnät av kort.

  Steg 2 är **sektionsvyn**, de befintliga `SeatGrid`-data i en
  `react-zoom-pan-pinch`-container:
  - **Styrning:** knappar +/−/återställ, "← Alla sektioner" och Escape. Legend och
    "3/5 valda".
  - **Stolarna:** varje stol är ett `<g role="button" tabIndex aria-pressed
    aria-label>`.
  - **Tangentbord:** roving tabindex per rad, piltangenter mellan stolar, Enter eller
    Space växlar.
  - **Klick mot drag:** ett tryck räknas som klick bara om pekaren rört sig <6 px.
  - **Prestanda:** `memo` per stol. Statusuppdateringar (polling 2 s + WS
    "stol tagen") renderar bara om ändrade stolar.
  - **Fler än 5 stolar:** vid ett sjätte försök visas en notis "Max 5 stolar". Gränsen
    håller backend fortfarande i.
- **E. Bokningssammanfattning.**
  - **Placering:** från `lg` en sticky högerkolumn på 360 px. Under det en bottenpanel
    (minimerad rad "3 platser · 1 185 kr · Fortsätt", expanderbar).
  - **Innehåll:** event, sektion, valda stolar (rad/plats/pris), och en *preliminär*
    summa märkt som preliminär. Knapp: **"Reservera och gå vidare"**, eftersom
    reservationen måste finnas innan betalning (befintligt flöde).
  - **Efter reservationen:** visar serverns summa och timern.
  - **Avgifter:** ingen avgiftsrad. Backend har inga avgifter, och frontend hittar
    aldrig på egna.
- **F. Checkout** (ombyggd `ReservationPage`).
  - **Steg-indikator:** Platser → Granska → Betala → Klart.
  - **Innehåll:** biljetterna från *serverns* reservation, kunden (namn och e-post från
    Auth0 + "Inte du? Logga ut"), prisuppdelning och total från servern, och
    reservationstimern tydligt (varning under 60 s).
  - **Knapp:** "Betala med Stripe". Under den: "Betalningen sker hos Stripe. Vi ser
    aldrig dina kortuppgifter."
  - **Fel:** reservationen utgången → tillbaka till kartan. Checkout misslyckades →
    "Försök igen" med samma idempotency-key.
  - **Bekräftelsesidan** pollar `GET /orders/:orderId`. `pending` → "Bekräftar
    betalningen…", `paid` → bekräftelse + biljetter + QR-länk. Efter 60 s utan `paid` →
    "Vi har inte fått bekräftelsen än", med länk till Mina biljetter. Den visar
    **aldrig** "klart" bara för att användaren kom tillbaka från Stripe.
  - **Avbrytsidan** kollar om reservationen är aktiv och erbjuder i så fall "Försök
    igen".
- **Mina biljetter:** ett kort per order med biljetter. QR-koden öppnas i en
  helskärmsmodal med max ljusstyrka-vänlig vit bakgrund. Badge när sidan visas offline.

*UI-tillstånd (alla sidor):*

| Tillstånd | Visning |
|---|---|
| Laddar | skeletons med samma form som innehållet (ingen layout-hoppning) |
| Tomt | EmptyState: inga events i kategorin / inga sökträffar / inga biljetter än |
| API-fel | ErrorState + "Försök igen" (TanStack `refetch`) |
| Nätverk nere | global banner (`navigator.onLine` + misslyckade anrop): "Du är offline" |
| Slutsålt | badge + avstängd knapp + text |
| Stol tas under valet | stolen blir "upptagen", tas bort ur valet, notis "Rad C plats 12 togs av någon annan" (befintliga `useSeatTakenNotifications`) |
| Reservationen går ut | modal "Tiden gick ut — platserna är släppta" + "Välj nya platser" |
| Betalning misslyckas/avbryts | avbryt-sidan, enligt ovan |
| Betalning lyckas | verifierad bekräftelse, enligt ovan |
| Köanslutning tappad | banner + automatisk återanslutning, platsen behålls |
| Mobil | bottenpanel, sticky knappar, pinch-zoom, tryckytor ≥44 px |
| Tangentbord/a11y | allt nåbart med Tab, synlig fokusring, `aria-live` för kö och notiser, landmarks (`header/nav/main`), rubrikhierarki, `lang="sv"` |

*Komponentstruktur* (`apps/web/src`):
- `styles/globals.css`: Tailwind + daisyUI-plugin + fontimport + `@import` av temat
  `tikknet` från `shared/ui-theme/theme.css` (skapas här i steg 7, så scannern i steg 9
  återanvänder det utan flytt).
- `components/ui/`: Button, Badge, Card, Alert, Skeleton, EmptyState, ErrorState, Modal,
  BottomSheet, Spinner, Container.
- `components/layout/`: AppShell, Navbar (flyttas hit, använder loggan), OfflineBanner.
- `features/events/`: EventCard (flyttas), FeaturedCarousel, CategoryChips, EventHero,
  EventInfo, AvailabilityBadge.
- `features/queue/`: QueueScreen, QueuePosition, ConnectionBanner.
- `features/seatmap/`: VenueOverview, SectionShape, SectionView, Seat (ersätter
  SeatGrid), SeatLegend, ZoomControls, `use-seat-keyboard-nav.ts`.
- `features/booking/`: BookingSummaryPanel, MobileSummaryBar, SelectedSeatList,
  ReservationTimer (bygger på Countdown).
- `features/checkout/`: CheckoutSteps, CheckoutReview, PaymentStatusPoller,
  OrderConfirmation.
- `features/tickets/`: TicketCard, QrModal.
- `lib/format.ts`: `formatPrice` (öre → "1 185 kr") och `formatEventDate`, en plats
  för `Intl`.
- `api-client.ts` utökas, de befintliga hookarna lämnas orörda.
- `routes/`: tunna sidor som komponerar features.

Ingen affärsregel dupliceras. Summor och priser kommer från servern. Gränsen på 5 stolar
och kölogiken avgörs av backend, och frontend speglar dem bara.

*Backend-integrationer:* E1–E6 i **7.13** (exakt byggplan där). UI:t byggs mot de
fälten och endpointsen, inget annat.

*Testning* (e2e-kraven i detalj: **7.15**):
- **Unit (Vitest + Testing Library):** Seat (aria-label och status), BookingSummary
  (visar serverns summa), alla tillstånd i QueueScreen, PaymentStatusPoller med fake
  timers, `format.ts`.
- **Tillgänglighet:** `vitest-axe` på varje sidkomponent, `@axe-core/playwright` på
  start-, event-, kart- och checkoutsidan i e2e.
- **Kontrasttest:** ett skript som räknar temats par från OKLCH och failar under
  4,5 (text) / 3 (grafik).
- **e2e:** befintliga `booking-flow.spec.ts` uppdaterad till roll- och
  label-selektorer, plus ett test där en stol väljs med bara tangentbordet.
- **Visuell kontroll:** Playwright-skärmdumpar i 375/768/1280 px av de fyra
  huvudsidorna, granskas manuellt.
- **Lighthouse (mobil) på start- och eventsidan:** prestanda ≥90, tillgänglighet ≥95.

*Klart när:* alla sidor använder temat och `components/ui`. Inga hårdkodade hex-koder
utanför `globals.css`. Kontrasttestet, axe och e2e är gröna. Ett helt köp går att göra
med bara tangentbord och på en 375 px-skärm. Stolstatus går att förstå utan färg.
Bekräftelsesidan visar "klart" först när backend säger `paid`. Lighthouse-målen nås.
Befintliga hooks och endpoints fungerar som förut.

*Byggordning* (designsystem och en representativ bokningsvy först):
1. Designsystem: Preflight + daisyUI + tema + font + `components/ui` + AppShell.
2. Arenakarta + bokningspanel (E2–E4).
3. Kösida.
4. Checkout + verifierad bekräftelse (E5–E6).
5. Start- och eventsida (E1, bilder från 7.6).
6. Mina biljetter, tomma och fel-tillstånd, favicon/PWA-ikoner från loggan.
7. Tester, a11y och Lighthouse.

Steg 1–6 deployas tillsammans, eftersom Preflight annars bryter de sidor som inte är
klara.

*Risker:*
- Preflight bryter ostylade sidor → allt i en release.
- e2e-selektorer går sönder → roll- och label-selektorer.
- Lasttestarenan saknar `layout` → kortrutnätet som reserv.
- Pan mot klick på mobil → tröskel på 6 px.
- Amberfärgen klarar bara 3:1 → randningen bär budskapet.
- Gammal CSS i PWA-cachen → service workerns uppdateringsflöde testas.
- Omfånget är stort ovanpå resten av Fas 7 → byggordningen ovan gör att flödet är
  demobart efter steg 4.

**7.12 Dokumentation** (planens ursprungliga Fas 7).
- *README* (engelska): uppfyller inlämningskravet (adresser till api, `cdn.tikknet.se`
  och dashboard), proffsig för rekryterare. Kort sammanfattning högst upp (vad, stack,
  länkar, de viktigaste resultaten — t.ex. lasttestsiffrorna), sedan arkitektur, hur man
  kör, tester, drift. Inte för lång, låter som en människa, inte som AI. Utkast skrivs i
  denna fas och granskas av användaren.
- `architecture.md` (6 rader idag): request → databas, merge → deploy, diagram.
- *Nya ADR:er:* k3s på Hetzner i stället för managed Kubernetes · DNS round-robin direkt
  mot noderna utan LB (+ lärdomen från lasttestet) · sharding per event · PostHog EU +
  reverse proxy · scanner som webbapp i stället för Expo · Pact utan broker.
- `runbook.md`: RPO/RTO ifyllt (7.5), `loadtest-mode`, Loki-felsökning, CSV-seed.
- *Känd risk att nämna i försvaret:* klustret kör k3s `v1.31.4`, och Kubernetes 1.31
  stöds inte längre upstream. Uppgraderas *inte* före försvaret (för riskabelt) — nämns
  som nästa steg.

**7.13 Nya och ändrade endpoints — exakt byggplan.** Alla i booking-api om inget annat
anges. Varje endpoint följer `docs/rules.md`:
- **Lager:** `routes/` → `controllers/` → `services/` → `repositories/`, konvertering i
  `mappers/`.
- **Indatavalidering:** Zod-scheman i `shared/schemas`.
- **Fel:** domänfel från `shared/domain` via `routes/error-handler.ts` (NotFoundError →
  404 osv).
- **SQL:** all SQL parameteriserad i repositories, `event_id` i varje fråga mot en
  shardad tabell.
- **Tester:** varje route får minst ett lyckat och ett misslyckat integrationstest
  (Testcontainers) och ett Pact-provider-test (7.9).

**API-ändringar är bara additiva:** nya fält och nya endpoints, aldrig byta namn eller
ta bort. Då fungerar en gammal frontend mot ny backend under en rullande deploy.
**Migrationer är bara additiva** (nya nullable kolumner, eller med default; nya tabeller
och index) och körs som migrations-Jobbet *före* koden, som idag. Pengar anges alltid i
öre (`*Cents`), valuta `SEK`.

- **E1 — `GET /events` och `GET /events/:eventId` (ändras).**
  - *Migration* `shared/db/migrations/sharded/1700000014000_add-event-presentation.ts`:
    `events.image_url text NULL` (relativ nyckel, t.ex. `images/neon-rivers.webp`),
    `events.description text NULL`, `events.featured boolean NOT NULL DEFAULT false`.
    Plus index `seats (event_id, status)`.
  - *Repository* `events-repository.ts`: `EVENT_ROW_SELECT` får aliaset `FROM events e`,
    de tre nya kolumnerna och en `LEFT JOIN LATERAL (SELECT MIN(price_cents) AS
    min_price_cents, MAX(price_cents) AS max_price_cents,
    COUNT(*) FILTER (WHERE status = 'available') AS available_seats, COUNT(*) AS
    total_seats FROM seats s WHERE s.event_id = e.id) agg ON true`. Gäller både
    lista (per shard, som idag) och enskilt event.
  - *Service:* ny `services/event-availability.ts` med `computeAvailability(row, now)`.
    Regeln, i denna prioritetsordning:
    1. `status <> 'scheduled'` eller `isAfterClose` → `closed`.
    2. `isBeforeOpen` → `opens_soon`.
    3. `available_seats = 0` → `sold_out`.
    4. `available_seats ≤ max(10, ceil(total_seats × 0,1))` → `few_left`.
    5. Annars `on_sale`.

    `now` är samma Postgres-baserade tid som `isBeforeOpen`/`isAfterClose` redan bygger
    på. Regeln ligger bara i backend.
  - *Mapper* `event-mapper.ts`: lägger till `imageUrl` (absolut URL =
    `PUBLIC_ASSET_BASE_URL` + `image_url`, eller `null`), `description` (eller
    `null`), `featured`, `minPriceCents` och `maxPriceCents` (eller `null` om eventet saknar
    stolar),
    `availableSeats`, `totalSeats`, `availability`.
  - *Ny env* på booking-api: `PUBLIC_ASSET_BASE_URL=https://cdn.tikknet.se/` (7.19),
    i `infra/k8s/base/booking-api/deployment.yaml`.
  - *Cache:* den befintliga cache-policyn för `GET /events` behålls.
    `availableSeats` och `availability` är därför ungefärliga upp till policyns TTL,
    vilket är acceptabelt för en badge. Det som avgör om en plats faktiskt går att
    boka är alltid reservationsanropet.
  - *Tester:* availability-regeln unit-testas för alla fem fallen och gränsen
    exakt på `few_left`. Integration: list + detalj innehåller fälten, och `imageUrl`
    är `null` när kolumnen är `NULL`.
- **E2 — `GET /events/:eventId/sections/summary` (ny, publik).**
  - *Migration* `shared/db/migrations/global/1700000005000_add-venue-layout.ts`:
    - `venue_sections.layout_x/layout_y/layout_width/layout_height numeric NULL`,
      `venue_sections.layout_rotation numeric NOT NULL DEFAULT 0`.
    - `venues.stage_x/stage_y/stage_width/stage_height numeric NULL`.
    - Koordinatsystem: en abstrakt ruta 0–1000 × 0–700 (SVG-viewBox).
  - *Repositories:*
    - `venues-repository.ts`: `listSectionsWithLayout(globalPool, venueId)` och
      `getVenueStage(globalPool, venueId)`.
    - `seats-repository.ts`: `aggregateSeatsBySection(pool, eventId)` = `SELECT
      section_id, COUNT(*) FILTER (WHERE status='available') AS available_count,
      COUNT(*) AS total_count, MIN(price_cents), MAX(price_cents) FROM seats WHERE
      event_id = $1 GROUP BY section_id`.
  - *Service* `seatmap-service.ts`: `getSectionSummary(deps, eventId)`.
    1. Hämta eventet (404 om det saknas).
    2. Hämta sektioner + scen från global-poolen och aggregaten från eventets shard.
    3. Slå ihop per `section_id`. Sektioner utan stolar för eventet utelämnas.
    4. Varje sektion får `availability` via samma `computeAvailability`-tröskel
       (`sold_out` / `few_left` / `on_sale`).
  - *Svar:* `{ stage: {x,y,width,height} | null, sections: [{ id, name, displayOrder,
    layout: {x,y,width,height,rotation} | null, availableCount, totalCount,
    minPriceCents, maxPriceCents, availability }] }`, sorterat på `displayOrder`.
  - *Fallback:* `layout` är `null` för venues utan layout (lasttestarenan). UI:t visar då
    kortrutnätet (7.11 D).
  - *Tester:* lyckat (aggregaten stämmer mot seedade stolar), 404 för okänt event,
    `layout: null`-fallet.
- **E3 — layoutdata (ingen egen endpoint).** Fylls av CSV-seeden (7.6):
  - `seed/venues.csv` får kolumnerna `section_x, section_y, section_w, section_h,
    section_rotation, stage_x, stage_y, stage_w, stage_h`. Scenvärdena upprepas per rad
    och valideras som identiska per venue.
  - Stolarnas `venue_seats.x/y` genereras av seed-scriptet i sektionens lokala
    rutnät (rad × plats), som dagens `SeatGrid` redan förväntar sig.
- **E4 — `GET /events/:eventId/sections/:sectionId/seats/status` (ändras).**
  `listSeatStatusesForSection` hämtar även `price_cents`, och mappern lägger till
  `priceCents` per post. *Tester:* befintliga tester utökas med fältet.
- **E5 — `GET /events/:eventId/reservations/:reservationId` (ändras, samma
  kötoken-auth).**
  - *Repository* `reservation-repository.ts`: ny `getReservationSeatDetails(pool,
    eventId, reservationId)` = `SELECT s.id, s.section_id, s.row, s.number,
    s.price_cents FROM seats s WHERE s.event_id=$1 AND s.reservation_id=$2`.
    Sektionsnamnen hämtas från global-poolen (`venues-repository.getSectionNames`).
  - *Service:*
    - `getReservationForQueueToken` returnerar dessutom `seats` (sorterade på
      sektionens `displayOrder`, rad, plats) och `totalCents`.
    - `totalCents` räknas av **samma** funktion som checkout använder
      (`sumSeatPrices`, utbruten ur `checkout-service.ts` till
      `services/pricing.ts`). Summan som visas och summan som debiteras kan då aldrig
      skilja sig.
  - *Svar* (additivt): `seats: [{ seatId, sectionId, sectionName, row, number,
    priceCents }]`, `totalCents`, `currency: 'SEK'`.
  - *Tester:* summan i GET är lika med det belopp checkout skickar till Stripe
    (assert mot payment-mockens session).
- **E6 — `GET /events/:eventId/orders/:orderId` (ny, kräver Auth0-inloggning).**
  `eventId` ingår i URL:en eftersom ordrar är shardade per event.
  - *Checkout-ändring:* `checkout-service.ts` sätter `success_url` till
    `CHECKOUT_SUCCESS_URL` + `event_id` och `order_id` som query-parametrar, byggt med
    `new URL()` + `searchParams.set` så en befintlig query bevaras (orderId är känt före
    Stripe-anropet via `deriveOrderId`). `cancel_url` byggs likadant med `event_id` och
    `reservation_id`. Bakåtkompatibelt: dagens bekräftelsesida ignorerar parametrarna.
  - *Repositories:*
    - `orders-repository.ts`: `getOrderForUser(pool, eventId, orderId, userId)` =
      `SELECT id, event_id, status, total_cents FROM orders WHERE event_id=$1 AND id=$2
      AND user_id=$3`, plus antal biljetter från `tickets`.
    - `users-repository.ts`: `findUserIdByAuth0Sub(globalPool, sub)`. Bara läsning,
      skapar inte användaren (till skillnad från `ensureUser`).
  - *Service:* ny `services/order-status-service.ts`. Okänd användare, okänd order eller
    annans order → `NotFoundError` (404, avslöjar inte om ordern finns).
  - *Route:* `routes/orders.ts` med `createRequireAuth0User`. Per-IP-gränsen räcker:
    frontend pollar var 2:a sekund i max 60 s.
  - *Svar:* `{ orderId, eventId, status: 'pending'|'paid'|'refunded'|'cancelled',
    totalCents, ticketCount }`.
  - *UI-mappning (7.11 F):* `pending` → fortsätt polla. `paid` → bekräftelse.
    `refunded` → "Betalningen kom efter att reservationen gått ut och har återbetalats".
    `cancelled` → "Ordern avbröts".
  - *Tester:* egen order (200), annans order (404), utan token (401).
- **E7 — `POST /scans` (ny, kräver permission `scan:tickets`).**
  - *Migration* `shared/db/migrations/sharded/1700000015000_create-ticket-scans.ts`:
    - Tabellen `ticket_scans (id uuid pk default gen_random_uuid(), event_id uuid not
      null, ticket_id uuid not null, gate text not null, scanned_by text not null,
      scanned_at timestamptz not null default now())`.
    - Unikt index på `(event_id, ticket_id)`.
    - Index på `tickets (event_id, qr_token)`.
  - *Auth:* ny preHandler `createRequirePermission(verifier, 'scan:tickets')` i
    `services/booking-api/src/controllers/auth0-controller.ts`, bredvid
    `createRequireAuth0User` (där den befintliga ligger, inte i `shared/auth`). Den
    verifierar token med samma `Auth0Verifier` och kräver att `payload.permissions` är
    en array som innehåller strängen, annars 403. Den kräver **inte** email-claimet
    (staff behöver bara `sub`). Den sätter `request.staffSub`.
  - *Body (Zod)* `shared/schemas/src/scan.ts`: `{ eventId: uuid, qrToken: string
    (64 hex-tecken), gate: string (1–32 tecken) }`.
  - *Service* `services/scan-service.ts`. I en transaktion på eventets shard:
    1. `SELECT t.id, t.status, s.section_id, s.row, s.number FROM tickets t JOIN seats s
       ON s.id = t.seat_id AND s.event_id = t.event_id WHERE t.event_id=$1 AND
       t.qr_token=$2`.
    2. Ingen rad → `not_found`. `status` ≠ `valid` → `refunded` resp. `void`.
    3. Annars `INSERT INTO ticket_scans … ON CONFLICT (event_id, ticket_id) DO NOTHING
       RETURNING scanned_at`.
    4. Ingen rad tillbaka → läs den befintliga raden → `already_scanned { scannedAt,
       gate }`.
    5. Annars `ok { sectionName, row, number }`. Sektionsnamnet hämtas från
       global-poolen efter transaktionen.
  - *Svar:* alltid 200 med `{ result: 'ok'|'already_scanned'|'not_found'|'refunded'|
    'void', … }`. En nekad biljett är ett affärsutfall, inte ett HTTP-fel. 400 bara
    vid ogiltig body, 401/403 vid auth.
  - *Rate limit:* rate limitern är en egen `onRequest`-hook (`routes/rate-limit.ts`),
    inte Fastifys plugin. `/scans` läggs därför till i dess `EXEMPT_PATH_PREFIXES`,
    samma mekanism som `/health/` och Stripe-webhooken använder. Grindarna sitter ofta
    bakom samma NAT-IP, och routen är skyddad av auth. Ett test visar att `/scans` inte
    ger 429 över gränsen och att andra routes fortfarande gör det.
  - *CORS:* `https://scan.tikknet.se` läggs till i `CORS_ALLOWED_ORIGINS` i
    `infra/k8s/base/booking-api/deployment.yaml`, och `http://localhost:5174` i
    `.github/workflows/e2e.yml`. `POST` finns redan bland de tillåtna metoderna.
  - *Händelse:* `ticket_scanned { result }` till PostHog (7.7).
  - *Tester:*
    - ok, dubbel → `already_scanned`, fel event → `not_found`, återbetald → `refunded`.
    - 403 utan permission.
    - Två samtidiga skanningar av samma biljett → exakt en `ok` (`Promise.all` mot
      riktig Postgres).
- **E8 — payment-mock `GET /mock-checkout/:sessionId` (ny).** Sessionen sparar
  `success_url` och `cancel_url` när den skapas. Routen svarar med 302 till
  `success_url`, med `{CHECKOUT_SESSION_ID}` ersatt om den finns. Okänd session → 404.
  Gör att e2e och systemtester går samma väg som riktig Stripe (tillbaka till
  bekräftelsesidan). *Tester:* 302 med rätt `Location`, och 404.

- **E9 — `GET /me/tickets` (ändras, additivt).** Biljettkorten i 7.11 behöver mer än
  titeln.
  - Varje order får `eventStartsAt`, `venueName` och `venueCity`.
  - Varje biljett får `sectionName`.
  - Hämtas i `my-tickets-service.ts` med samma scatter-gather som idag, plus ett
    uppslag av venue- och sektionsnamn i global-poolen.
  - *Tester:* de befintliga utökas med fälten.

**7.14 Systemtester (black-box) — nytt testlager.**
- *Vad det är:* tester som kör hela flöden mot systemet utifrån, precis som en klient,
  utan att känna till koden. De kallas **systemtester** eller **black-box-tester**
  (ibland "API-nivå end-to-end" eller acceptanstester). e2e (Playwright) testar UI:t i
  en webbläsare. Systemtesterna testar systemets *beteende och data*: rätt svar från
  ett flöde och rätt tillstånd i databasen.
- *Princip — ändras inte när koden ändras:*
  - Testerna får **bara** använda det publika HTTP-API:t (booking-api och payment-mock)
    och **läsande SQL** för att kontrollera databasen.
  - De får aldrig importera något från `services/` eller `shared/`. Det upprätthålls
    av en ESLint-regel (`no-restricted-imports`) i `tests/system/`.
  - De kontrollerar bara kontraktet (statuskoder och de fält som dokumenteras i 7.13
    och tidigare faser) och invarianter. Inga interna detaljer som loggtexter eller
    tabellernas övriga kolumner.
  - Byts implementationen ut men beteendet är samma ska testerna vara gröna utan att
    ändras.
- *Plats och verktyg:* `tests/system/` som eget pnpm-paket, Vitest i Node, `fetch` och
  `pg`. Varje test skapar sitt **eget** event via en fixture-hjälpare (SQL-insert av
  event + stolar, samma teknik som `tests/e2e/seed.ts`). Testerna är därför oberoende
  av körordning och av varandras data.
- *Miljö:* samma lokala stack som e2e-jobbet i CI (Postgres ×2, Redis, RabbitMQ,
  booking-api, payment-mock, scheduler-worker). payment-mock körs deterministiskt:
  `PAYMENT_MOCK_FAILURE_RATE=0`, `PAYMENT_MOCK_LATE_WEBHOOK_RATE=0`,
  `PAYMENT_MOCK_DUPLICATE_WEBHOOK_RATE=1` (alltid dubbla webhooks, så idempotensen
  testas varje gång), latens 50–200 ms. **Detta ändras i `.github/workflows/e2e.yml`**
  (idag 0 dubbletter, latens 50–500 ms). Det gäller då både e2e och systemtester, och
  e2e tål det eftersom webhooken är idempotent. Rate limit är redan 1000/s i CI-stacken.
- *Inloggning:* access token via password grant mot en **egen Auth0-applikation "CI
  System Tests"** (aldrig produktionens SPA-app, jfr runbookens varning), med samma
  testkonto som e2e plus ett **andra** testkonto (krävs för F6, "annan användares
  order"). Den appen används även för lasttestets tokens. Skapas manuellt (7.17).
- *Väntan:* aldrig `sleep`. En hjälpare `waitFor(cond, timeoutMs)` pollar villkoret var
  200:e ms (rules §8).
- *Flöden* (ett testfall var):
  - **F1 Helt köp:**
    1. Join kö → vänta tills `admitted` → läs sektioner och stolstatus.
    2. Reservera 2 lediga stolar → 201. GET reservation: `seats` och `totalCents` ska
       vara summan av stolarnas priser.
    3. Checkout → 201 + `checkoutUrl`. GET `checkoutUrl` → 302 till success-URL med
       `order_id`.
    4. Vänta tills GET order ger `paid`.
    5. DB: ordern `paid`, exakt 2 biljetter `valid` med unika `qr_token`, stolarna
       `sold`.
    6. `GET /me/tickets` innehåller de 2 biljetterna.
  - **F2 Samma stol, två köpare:** två kötoken reserverar samma stol samtidigt → exakt
    en 201 och en 409. DB: stolen har exakt en aktiv reservation.
  - **F3 Max 5:** reservera 6 stolar → 4xx. DB: inga stolar ändrade.
  - **F4 Dubbel webhook:** efter F1-liknande köp → exakt en `paid`-order och 2
    biljetter, aldrig 4.
  - **F5 Reservationen går ut:**
    1. Sätt `reservation_hold_minutes=1` i config (test-setup, återställs i
       `afterAll`).
    2. Reservera, vänta tills GET reservation ger `expired`.
    3. Stolarna är `available` i statusendpointen, och checkout ger 4xx.
  - **F6 Orderstatus-säkerhet:** en annan användares token mot ordern → 404.
  - **F7 Skanning** (tillkommer med scannern):
    1. Skanna en köpt biljett → `ok`, sedan igen → `already_scanned`.
    2. Fel event → `not_found`.
    3. Token utan permission → 403.
    4. DB: exakt en rad i `ticket_scans`.
  - **Invarianter** (sist i sviten, över alla events som skapats):
    - sålda biljetter ≤ eventets stolar,
    - inget `ticket_number` i mer än en `valid` biljett,
    - varje `paid` order har lika många `valid` biljetter som reserverade stolar,
    - ingen stol `sold` utan en `valid` biljett.
- *CI:* nytt steg "Run system tests" i e2e-jobbet efter e2e-sviten (stacken körs redan
  där). Blockerar deploy precis som e2e.
- *Lokalt:* `pnpm --filter @tickets/system-tests test` mot `docker compose up` + de
  startade tjänsterna (dokumenteras i `tests/system/README.md`).
- *Inte med (medvetet):* sen betalning efter utgången reservation (kräver
  icke-deterministisk timing, täcks av integrationstester) och prod som mål. Prod
  verifieras av `smoke.js` + `loadtest-mode`s paid-kontroll, inte av skrivande
  systemtester.

**7.15 e2e-testerna måste uppdateras enligt denna plan.** UI-ombyggnaden (7.11) ändrar
markup, routes och flöde. `tests/e2e` uppdateras i **samma** steg som UI:t och måste
vara grönt innan UI-steget räknas som klart:
- **Selektorer:** alla byts till roll-, label- och textbaserade
  (`getByRole('button', { name: 'Reservera och gå vidare' })` osv). Inga CSS-klasser,
  inga strukturella selektorer.
- **`booking-flow.spec.ts`:**
  1. Startsida → EventCard → eventsida → "Boka biljetter".
  2. Ny kö-route `/events/:id/queue` → automatisk vidarebefordran till kartan.
  3. Översikt eller sektionskort → sektion → välj stolar → bokningspanelen → reservera.
  4. Checkoutsidan (summa från servern) → betala → payment-mockens 302 (E8) →
     bekräftelsesidan som väntar in `paid` (E6) → "Mina biljetter" visar QR.
- **Nya spec-filer:**
  - `keyboard-booking.spec.ts`: välj stol och reservera med bara tangentbord.
  - `mobile-booking.spec.ts`: 375 × 812, bottenpanelen.
  - `reservation-expiry.spec.ts`: `reservation_hold_minutes=1` → modalen "Tiden gick
    ut".
  - `seat-taken.spec.ts`: en annan klient reserverar samma stol → notisen visas.
  - `a11y.spec.ts`: `@axe-core/playwright` utan `serious`/`critical`-fel på start-,
    event-, kö-, kart- och checkoutsidan.
  - `scanner.spec.ts`: inloggad staff (fake camera stream + injicerad QR) →
    `ok` → `already_scanned`.
- **PostHog (7.7):** e2e-bygget av webbappen får `VITE_POSTHOG_KEY=phc_e2e_dummy` och
  `VITE_POSTHOG_HOST=<appens origin>/ingest`. Playwright fångar `**/ingest/**` med
  `page.route` och svarar själv: händelser sparas för assertion, och `/decide` svarar med
  fasta flaggor (`show_seats_left_badge: true`). Ingen trafik når PostHog. booking-flow
  kontrollerar att `queue_joined`, `reservation_created` och `checkout_started`
  skickades.
- **Samtyckesbannern:** varje spec sätter samtycket via `localStorage` i
  `test.beforeEach` (en hjälpare i `tests/e2e/helpers/consent.ts`). Bannern testas
  separat i `consent.spec.ts`: före samtycke är `persistence` minnesbaserad, efter
  "Godkänn" finns PostHogs cookie.
- **CI:** e2e-jobbet bygger och startar även `apps/scanner`.

**7.16 Byggordning.** Stegen byggs enligt fas-arbetsflödet (plan → bygg → test →
review → fix → rapport). Användaren committar, pushar och mergar.

*Brancher:* sex (A delas i A1–A3, en logisk ändring per PR, docs/rules.md §10), plus `hotfixes` (steg 0) som mergas först. Inom en branch pushas efter
**varje** steg och CI måste vara grön innan nästa steg börjar. Mergen sker först när
hela gruppen är klar. En merge till `main` startar deployen.

| Branch | Steg | Mergas |
|---|---|---|
| A1 `fas7-ci` | 1a (7.10) | först, gör alla senare steg snabbare |
| A2 `fas7-drift` | 1b (7.1 + 7.2), 2–3 (steg 2 byggdes i `fas7-matbarhet`) | före försvaret |
| A3 `fas7-cdn` | 1c (7.19) | före B:s seed (steg 6), helst direkt efter A2 |
| B `fas7-backend` | 4–6 | före C |
| C `fas7-ui` | 7 | före försvaret |
| D `fas7-extra` | 8–10 | före inlämningen. Scanner (9) delas ut som egen branch om D växer |

**B måste ligga i prod före C mergas.** `deploy-frontend` laddar upp den nya webbappen
innan den nya backenden har rullat ut (några minuter), så en ny frontend mot gammal
backend går sönder under den tiden. Därför får B och C aldrig slås ihop. C är en enda
release eftersom Tailwinds Preflight annars bryter sidor som inte är omgjorda.

*Prod-verifiering* görs bara där resultatet inte syns annars: steg 1b (Loki), 1c (cdn), 2
(Grafana), 3 (beviset), 6 (seedade events i prod-API:t), 9 (scannern på en riktig
telefon), samt en genomgång av UI:t i prod efter C. För övriga steg räcker grön CI.

**[G/VG]** = får aldrig skäras.

| # | Steg | Innehåll | Beroenden | Klart när |
|---|---|---|---|---|
| 0 | Förberedelser | commit av `hotfixes`-branchen (rabbitmq, helm.tf, LASTTEST-NOTES, planen). Användarens manuella steg i 7.17 påbörjas (kan pågå parallellt med steg 1–5) | — | `main` innehåller allt från lasttestet |
| 1a | **[G]** Snabbare CI (branch A1) | 7.10 | 0 | CI ≤ ~6 min. *Status: byggt och granskat, väntar på merge + mätning av andra deploy-körningen* |
| 1b | **[G]** Drift (branch A2) | 7.1 (permanenta ändringar + `loadtest-mode.sh`), 7.2 Loki | 0 | Loki visar loggar i Grafana. `loadtest-mode on/off` provkört. *Status: byggt och granskat, väntar på merge, `terraform apply` och provkörning* |
| 1c | **[G]** cdn (branch A3) | 7.19 | 0 | `cdn.tikknet.se/brand/tikknet-icon.svg` svarar 200. *Status: byggt och granskat, väntar på merge, `terraform apply` och `curl`-verifiering* |
| 2 | **[VG]** Mätbarhet | ingress-nginx-metrics, 7.4 Grafana-paneler, 7.5 återställningsövning | 1b | Panelerna visar data. RPO/RTO ifyllt i runbook. *Status: klart 29/10. Måtten skrapas, panelerna visar data, återställningsövningen körd (RTO ≈ 3 s, RPO ≤ 24 h, ifyllt i runbook). Backup-felet (rclone `CreateBucket` 403) hittades och fixades. Öppet: deploy-annotationen triggas troligen även av HPA-skalning.* |
| 3 | **[VG]** Bevis | 7.3 deploy utan nertid. *Obs: `loadtest-mode on` lämnar `STRIPE_WEBHOOK_SECRET` som literal, vilket failar `kubectl apply` i en riktig deploy. Måste lösas före steg 3 (se 1b-rapporten).* *Obs från steg 2:* ingress-5xx-panelen ser inte de första 5xx-svaren (en ny `status`-serie startar på 1 och `rate()` räknar inte det första hoppet). `k6 http_req_failed` är det primära beviset. Läs dessutom råräknaren `nginx_ingress_controller_requests{status=~"5.."}` före/efter körningen och dokumentera det i `docs/evidence/zero-downtime.md`. | 2 | `http_req_failed rate==0` under minst en riktig deploy. Bevis i `docs/evidence/zero-downtime.md` *Status: byggt och granskat (`feature/fas7-zero-downtime`). Deployen är `kubectl rollout restart` ×2, inte en merge, eftersom `loadtest-mode on` lämnar literal `STRIPE_WEBHOOK_SECRET` (motivering i `docs/forsvar.md`). Väntar på att användaren kör beviset (runbook "Bevis: deploy utan nertid") och fyller i `docs/evidence/zero-downtime.md`. Planerat till när branch C är mergad, före försvaret 4/11 (avvikelse från 7.16, beslutad av användaren).* |
| 4 | Säkerhetsnät | 7.14 systemtester F1–F6 mot *nuvarande* API (inga nya fält) + Pact-infrastruktur och kontrakten för befintliga endpoints (7.9) | 1a | Gröna i CI. Byggs *före* API-ändringarna, så de skyddar dagens beteende när allt byggs om | *Status: byggt och granskat (`feature/fas7-backend`, steg 4–6 i en branch). Systemtester F1–F6 + invarianter i `tests/system` (körs som `test:system`; skrevs direkt mot slutläget med de nya fälten, eftersom 4–6 byggdes i ett svep) och Pact (web, payment-mock, notification-worker, realtime-gateway som konsumenter; booking-api och scheduler-worker som providers). F2, F3 och invarianterna provkörda lokalt; F1/F4/F5/F6 kräver Auth0-appen "CI System Tests" och körs första gången i CI.*
| 5 | Backend | E1–E6 + E8 + E9, migrationerna, Pact-kontrakten för dem, systemtesterna utökade med de nya fälten | 4 | Allt grönt. Nya fält syns i prod. Gamla frontenden fungerar oförändrad | *Status: byggt och granskat (`feature/fas7-backend`). E1–E6, E8, E9 och migrationerna, inklusive `ticket_scans` (E7:s migration byggdes här, själva endpointen hör till steg 9). `getUserByAuth0Sub` återanvänds i stället för `findUserIdByAuth0Sub`. Notering till steg 7: sätt `CHECKOUT_SUCCESS_URL`/`CHECKOUT_CANCEL_URL` i `e2e.yml` så mockens 302 landar på webbappen; `{CHECKOUT_SESSION_ID}` i bas-URL:ens query stöds inte. `GET /events` och `/sections/summary` saknar cache-header och kantregel, och eventlistan aggregerar alla stolar per anrop: lägg en kort `max-age` + Cloudflare-regel om startsidan blir långsam. `eventStartsAt` i `/me/tickets` är `null` om eventet saknas.*
| 6 | Seed | 7.6 CSV + bilder (bilderna godkänns av användaren först) + layout (E3) | 5, 1c (cdn) | 20 events syns i prod-API:t med `imageUrl`. Kartöversikt-data finns | *Status: byggt och granskat (`feature/fas7-backend`). `seed-events-from-csv.ts`, 5 arenor, 20 events, 20 genererade bilder (inte Unsplash, godkänt av användaren), uppladdning till `images/` i `deploy-frontend`. Väntar på merge, deploy och att scriptet körs mot prod (runbook "Seed: events från CSV"). Öppet: de 5 gamla demo-eventen från `seed-demo-events.ts` ligger kvar i prod, utan bild.*
| 7 | UI | 7.11 steg 1–7 + 7.15 e2e + logga/favicon | 5, 6 | Hela "Klart när" i 7.11 uppfyllt, e2e grönt |
| 8 | PostHog | 7.7 | 7 | Verifieringslistan i 7.7 klar |
| 9 | Scanner | 7.8 + E7 + F7 + scanner-e2e | 5, 7 (tema) | Riktig telefon skannar en riktig biljett i prod: ok → redan skannad |
| 10 | Dokumentation | 7.12 (README, architecture, ADR:er, runbook) | 1–9 | Användaren har granskat README |
| 11 | Slutverifiering | full CI, smoke mot prod, demomanuset genomkört, `loadtest-mode off`, loadgen-VM:er rivna | 10 | Checklistan i 7.18 avbockad |

Före försvaret 4/11 behövs minst steg 0–7.

**7.17 Manuella förutsättningar (användaren gör dessa, Claude kan inte).** De beskrivs
steg för steg när respektive steg börjar. Inget steg i 7.16 startar innan dess
förutsättningar är klara:
- **Steg 1b/1c:** Terraform-variablerna exporterade (se `infra/LASTTEST-NOTES.md`).
  `terraform apply` för Loki och ingress (1b) respektive cdn (1c) körs av användaren.
  Steg 1a har inga manuella förutsättningar.
- **Steg 4:**
  - En Auth0-applikation "CI System Tests" (Regular Web App, Password grant på,
    audience = API:t). Tenantens "Default Directory" måste vara satt, annars svarar
    `/oauth/token` med `unauthorized_client` (runbooken).
  - Ett andra testkonto i Auth0.
  - GitHub-secrets `AUTH0_CI_CLIENT_ID`, `AUTH0_CI_CLIENT_SECRET`,
    `SYSTEMTEST_USER2_EMAIL` och `SYSTEMTEST_USER2_PASSWORD`.
- **Steg 6:** godkänna de 20 föreslagna Unsplash-bilderna (Claude föreslår, laddar ner
  och lägger krediteringar i `seed/images/CREDITS.md`).
- **Steg 8:**
  - PostHog-konto i EU-regionen och ett projekt.
  - GitHub-secrets `VITE_POSTHOG_KEY` och `POSTHOG_KEY`.
  - Flaggan `show_seats_left_badge` skapad i PostHog (50/50).
- **Steg 9:**
  - Auth0: SPA-applikationen "Scanner".
  - På API:t: RBAC och "Add Permissions in the Access Token" på.
  - Permission `scan:tickets`, roll `staff`.
  - Ett staff-testkonto, och rollen tilldelad ett riktigt konto för demon.
  - GitHub-secrets `AUTH0_SCANNER_CLIENT_ID`, `E2E_STAFF_EMAIL` och
    `E2E_STAFF_PASSWORD`.

**7.18 Gemensamma regler och robusthetskontroll.**
- *Regler för hela fasen:*
  1. Ändra aldrig befintligt beteende utan att det står i denna plan. Befintliga hooks,
     endpoints och QR-format behålls.
  2. Bara additiva API- och DB-ändringar (7.13).
  3. Varje steg: typecheck, lint, unit, integration, Pact, system och e2e gröna
     **innan** review. Review av en fristående subagent enligt fas-arbetsflödet.
  4. Ett nytt designbeslut som inte står här → stoppa och fråga, gissa aldrig.
  5. Inga secrets i kod eller loggar.
  6. Varje steg pushas och CI måste vara grön innan nästa steg börjar. Varje *branch*
     deployas och verifieras (där 7.16 kräver det) innan nästa branch mergas. Går något
     sönder i prod: revert av branchens merge (migrationerna är additiva, så gammal kod
     fungerar mot ny databas).
- *Genomgångna luckor som nu är lösta i planen:*
  - **QR-formatet** kan inte avkodas → uppslag på `qr_token` per event (7.8, E7).
  - **Ordrar är shardade** → `eventId` i order-URL:en och i `success_url` (E6).
  - **Pris saknades** i stolstatus och reservation → E4/E5. Summan kommer från samma
    funktion som checkout.
  - **Bekräftelsesidan litade på återkomsten** från Stripe → E6 + polling.
  - **payment-mock saknade sida för återkomst** → E8.
  - **Chaos i payment-mock** gör tester instabila → deterministiska värden i
    test-stacken (7.14).
  - **ROPG på produktionens SPA-app** → egen CI-app (7.14, 7.17).
  - **Scanner-origin och CORS**, samt grindar bakom NAT och rate limit → E7, 7.8.
  - **`cdn.tikknet.se` saknades** (G-krav) → 7.19.
  - **Lasttestarenan saknar layout** och bild → fallbacks (E2, 7.11 A).
  - **Preflight bryter ostylade sidor** → hela UI-steget i en release.
  - **Deploy-under-load kunde inte visa 0 fel** → ny profil (7.3).
  - **Loki tyst trasig** → fix + larm (7.2).
  - **Webhook-secreten** → `loadtest-mode` (7.1).
- *Verifierat mot koden och de låsta versionerna 29/10* (inte antaget):
  - **Loki-chartet 19.0.3:** `loki.auth_enabled` har default `true`.
  - **ingress-nginx 4.15.1:** har `controller.metrics.serviceMonitor`.
  - **kube-prometheus-stack:** har `serviceMonitorSelectorNilUsesHelmValues = false`,
    så den nya ServiceMonitorn plockas upp utan etiketter.
  - **Rate limitern** är en egen hook med en lista över undantagna sökvägar.
  - **CORS** styrs av `CORS_ALLOWED_ORIGINS`.
  - **Auth:** `createRequireAuth0User` ligger i booking-api och kräver email-claimet.
  - **QR-koden** är en HMAC som inte går att avkoda.
  - **Tabellerna:** `seats` har `row`/`number`/`section_id`/`price_cents`/
    `reservation_id`. `orders` har `user_id`/`total_cents`/`status`. `users` har
    `auth0_sub`. Orderstatusar: `pending`/`paid`/`refunded`/`cancelled`.
  - **Config** (`reservation_hold_minutes`) läses per anrop utan cache.
  - **CI-stacken** har redan deterministisk chaos (0 % fel) och rate limit 1000/s.
  - **`cdn.<domän>`** finns inte i Terraform.
- *Fler luckor hittade i dubbelkollen och nu lösta:*
  - Undantaget i rate limitern kunde inte göras med Fastify-config → sökvägslista.
  - Scannerns behörighetskontroll placerades fel och skulle krävt email → egen
    preHandler.
  - PostHogs proxy behöver två värdar.
  - Klienten känner inte det interna user-id:t → Auth0 `sub` används som id.
  - Feature-flaggan hade hoppat utan samtycke → utvärderas bara efter samtycke.
  - `reservation_expired` saknar inloggad användare → personlös händelse.
  - PWA och iOS kräver PNG-ikoner → genereras.
  - cdn-Workern kunde ha exponerat backuperna → vitlista + test.
  - `immutable`-cache på oversionerade filnamn → 1 dag.
  - e2e-stacken körde 0 % dubbla webhooks → 100 %, så idempotensen testas.
  - F6 kräver ett andra testkonto → nya secrets.
  - Biljettkorten saknade datum, arena och sektion → E9.
  - Eventsidans prisintervall saknade maxpris → `maxPriceCents`.
  - Cloud-init-orsaken var en gissning → fixen tar bort beroendet + gör felet synligt.
- *Kvarvarande risker (accepterade, med åtgärd):*
  - **Omfånget mot tiden:** byggordningen gör att G/VG och ett demobart flöde är klart
    först, och skärning sker bakifrån.
  - **Unsplash-bildernas licens:** gratis att använda, kreditering i `CREDITS.md`.
  - **k3s 1.31 är EOL:** nämns i försvaret, ingen uppgradering nu.
  - **Ungefärligt `availableSeats` på grund av cache:** okej för en badge, bokningen är
    alltid sanningen.
- *Slutchecklista (steg 11):*
  - Alla G/VG-krav har ett belägg: api/cdn-URL:er, CI-körning, backup + återställning,
    Grafana metrics och Loki-loggar, ≥2 instanser, bevis för deploy utan nertid,
    HPA-kurvan.
  - README-adresserna fungerar.
  - `loadtest-mode off`, loadgen-VM:er rivna, `loadgen_node_count = 0`.
  - Demomanuset (nedan) genomkört från början till slut i prod.

**7.19 G-krav: `cdn.tikknet.se` (saknas idag).** `infra/terraform/dns.tf` säger att
`cdn.<domän>` skulle läggas till i Fas 5, men det gjordes aldrig.
- *Bygg:*
  - En `cloudflare_workers_custom_domain` för `cdn.tikknet.se` i
    `cloudflare-frontend.tf`. Den pekar på samma Worker, eller en liten egen Worker
    `cdn-proxy.js`, med en **vitlista**: bara nycklar som börjar på `images/` eller
    `brand/` läses, allt annat ger 404. Bucketen innehåller även databasbackuperna
    (`docs/adr/0005`), så detta är en säkerhetsgräns. Ett test (unit på Workern + `curl`
    i verifieringen) visar att `/backups/…`, `/frontend/…` och `/../` ger 404.
  - Cache-header `public, max-age=86400`. Inte `immutable`, eftersom filnamnen
    (`<slug>.webp`, `tikknet-logo.svg`) inte är versionerade och en ändrad bild annars
    aldrig skulle nå ut.
  - CORS `GET` från apex och `scan.`.
  - `deploy-frontend` laddar upp `apps/web/public/brand/` till `brand/`. Uppladdningen av
    `seed/images/` till `images/` byggs i steg 6 (7.6), när mappen finns.
- *Medvetet inte flyttat:* JS- och CSS-bundlen ligger kvar på apex. Att flytta den
  skulle kräva cross-origin-precache i service workern (PWA:n), en onödig risk. Eventbilder
  och varumärkesfiler på cdn uppfyller kravet "statiska filer på cdn.<domän>".
- *Notering till steg 6/7:* Workern svarar inte 304 på `If-None-Match` och cachar inte vid
  kanten, så varje bildvisning är en R2-läsning och allt hämtas om efter 24 h. Räcker för
  demon; om eventkorten blir märkbart långsamma, lägg till `get(key, { onlyIf })` + 304.
- *Verifiering:* `curl -I https://cdn.tikknet.se/brand/tikknet-icon.svg` → 200 +
  cache-header. Eventkorten laddar bilder från `cdn.tikknet.se`.

**Flyttat till efter inlämningen:** proof of work + Turnstile ·
PostHog session replay (om inte beslutat annat i 7.7) · ArgoCD + Sealed Secrets · Tempo-backend · DLQ med adminvy ·
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
