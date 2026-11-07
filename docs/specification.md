# tikknet — systembeskrivning

Beskriver **vad** systemet är och hur det ska bete sig: krav, domän, arkitektur och detaljerna per
område. Hur och när det byggdes står i fasdokumenten (`docs/phases/`), översikten och statusen i
[`plan.md`](./plan.md). Motiveringarna till vägvalen ligger i [`forsvar.md`](./forsvar.md), kodreglerna i
[`rules.md`](./rules.md), driftrutinerna i [`runbook.md`](./runbook.md) och diagrammen i
[`architecture.md`](./architecture.md).

Avsnittsnumren är desamma som när texten låg i `plan.md`. Avsnitt 14 (status, kända begränsningar)
ligger kvar i [`plan.md`](./plan.md).

---

## 1. Uppgiften

Praktisk examination, Chas Academy. Soloprojekt (godkänt av läraren). Mål: VG och ett
portfolioprojekt.

| Datum | Vad |
|---|---|
| ons 4/11 | Muntligt försvar, systemet demo-klart |
| sön 8/11 | Kodinlämning: repolänk + README med adresser till api, cdn och dashboard |

### Kraven och var de uppfylls

| Krav | Lösning | Belägg |
|---|---|---|
| **G** Backend på egen VPS, `api.<domän>` över HTTPS | k3s på Hetzner Cloud, Cloudflare framför | `https://api.tikknet.se` |
| **G** Statiska filer på `cdn.<domän>` | Cloudflare Worker framför R2 (vitlista `images/`, `brand/`) | `https://cdn.tikknet.se` |
| **G** CI/CD vid varje merge till main | GitHub Actions: test → images → migrations-Job → `kubectl apply` → `rollout status` | `.github/workflows/deploy.yml` |
| **G** Unit-, integrations- och e2e-tester i pipelinen | Vitest, Testcontainers, Pact, systemtester, Playwright | `ci.yml`, `test.yml`, `e2e.yml` |
| **G** Dagliga DB-backups till S3 | Nattlig `pg_dump` av båda shardarna till R2 (S3-kompatibelt) | Återställningsövning i runbook |
| **G** Metrics och logging | Prometheus + Grafana, Loki + Alloy | `https://grafana.tikknet.se` |
| **VG** ≥2 instanser bakom load balancer | booking-api 2–6 repliker bakom ingress-nginx + Service | HPA min 2 |
| **VG** Deploy utan downtime | Probes, `maxUnavailable: 0`, preStop, graceful shutdown | [`evidence/zero-downtime.md`](./evidence/zero-downtime.md): 0 fel av 22 978 |
| **VG** Autoscaling upp **och** ner | HPA (CPU) på booking-api, KEDA (ködjup) på notification-worker | Grafana "Autoscaling & lasttest" |

Vid försvaret ska hela lösningen kunna förklaras: demo av app, pipeline och dashboard,
request → databas, merge → deploy, kod och tekniska val, drift och backups, samt
autoscaling och zero-downtime under last.

---

## 2. Domän och användarflöde

Biljettbokning med platsval på en interaktiv arenakarta. 5 000 platser släpps under ett
15-minutersfönster och upp till 50 000 bokningsförsök kommer in. Uppgiftens CSV med de
5 000 giltiga biljettnumren är sanningen för vad som får säljas.

1. Välj evenemang → väntrum (eller direkt in om kön är tom) → arenakarta
2. Stolsstatus: **grön** ledig · **gul** reserverad av annan · **grå** såld · **blå** egen
   markering. Aldrig bara färg: även form och symbol skiljer statusarna
3. Max 5 stolar per bokning, behöver inte ligga intill varandra
4. "Reservera och gå vidare" → **allt-eller-inget**-reservation i 5 minuter
5. Inloggning (Auth0) och betalning (Stripe Checkout) under reservationstiden
6. Bekräftelsesidan visar "klart" först när servern säger `paid` → biljett med QR-kod under
   "Mina biljetter" + e-post
7. Vid timeout frisläpps stolarna. Dörrvärden skannar biljetten i scannern vid insläpp

---

## 3. Arkitektur

### Tjänster

| Tjänst | Roll | Repliker |
|---|---|---|
| `booking-api` | Fastify HTTP-API, bokningstransaktionen | 2–6 (HPA, CPU) |
| `realtime-gateway` | WebSocket-server (köplats, "din stol togs") | 2–4 (HPA, minne) |
| `scheduler-worker` | Insläpp från väntrum, frisläpp av utgångna reservationer, outbox-relay, engångsskript (import, seed, reset) | **exakt 1** (`Recreate` + advisory lock) |
| `notification-worker` | RabbitMQ-konsument: e-post med QR | 1–4 (KEDA, ködjup) |
| `payment-mock` | Simulerad betalleverantör med konfigurerbart kaos, för lasttest och CI | 1 (4 under lasttest) |
| `migrations` | Kubernetes Job per deploy, båda shardarna, advisory lock | Job |

Datatjänster i klustret: två Postgres-shardar, Redis, RabbitMQ. Ingen backoffice byggs.

### Klienter och adresser

| Adress | Vad |
|---|---|
| `tikknet.se` | `apps/web`, React-PWA för kunder (installerbar, offline för mina biljetter) |
| `scan.tikknet.se` | `apps/scanner`, webbapp för personal med rollen `staff` (kameran läser QR) |
| `api.tikknet.se` | booking-api, och `/ws` till realtime-gateway på samma host |
| `cdn.tikknet.se` | Eventbilder och varumärkesfiler |
| `grafana.tikknet.se` | Dashboards, inloggning via Auth0 |

Webben och scannern byggs i CI till statiska filer i R2 och serveras av Cloudflare Workers.
Bucketen delas med databasbackuperna, så varje Worker läser bara sitt eget prefix.

### Trafikväg

```
Webbläsare
  → Cloudflare (TLS, cache)
  → A-poster mot nodernas publika IP:443 (DNS round robin, ingen extern LB)
  → ingress-nginx (DaemonSet) — ruttar på värdnamn
  → Service (ClusterIP) — lastbalanserar över friska poddar
  → booking-api-podd: route → controller → service → repository
  → shard-router: hash(event_id)
  → Postgres shard-0 eller shard-1
```

### Stack

Node.js · TypeScript · Fastify · Zod · pnpm workspaces · Turborepo · Postgres · Redis ·
RabbitMQ · React + Vite (PWA) · TanStack Query · Tailwind 4 + daisyUI · Auth0 · Stripe ·
Terraform · k3s · Kustomize · Prometheus · Grafana · Loki · PostHog · Vitest ·
Testcontainers · Pact · Playwright · k6

### Repo

```
shared/     auth, db, domain, observability, rabbit, redis, schemas, analytics, types, ui-theme
services/   booking-api, realtime-gateway, scheduler-worker, notification-worker, payment-mock
apps/       web (PWA), scanner
infra/      terraform, k8s (Kustomize: base + production-overlay)
tests/      e2e (Playwright), system (black-box), load (k6)
seed/       venues.csv, events.csv, images/
docs/       plan (roadmap), specification, phases/, phase-status, rules, architecture, runbook,
            forsvar, adr/, evidence/
.claude/    agenter, skills, hooks och inställningar för Claude Code (ADR-0012)
```

Varje tjänst har samma interna struktur (`routes/ controllers/ services/ repositories/
mappers/ schemas/ types/`). Lagergränserna upprätthålls av ESLint (`eslint-plugin-boundaries`)
med ett eget regressionstest.

---

## 4. Bokningskärnan

**Postgres är sanningen.** Redis avgör aldrig om en stol får reserveras.

### Reservationen

En transaktion, alla stolar låses i sorterad ordning:

```sql
SELECT * FROM seats
WHERE id = ANY($1) AND event_id = $2
ORDER BY id
FOR UPDATE NOWAIT;
```

- **Allt-eller-inget:** är en enda stol tagen rullas hela reservationen tillbaka (409)
- **Deterministisk låsordning** (`ORDER BY id`) gör deadlock omöjlig
- **`NOWAIT`:** förloraren får svar direkt i stället för att hålla en anslutning och vänta.
  Krockar med vårt eget frisläppningsjobb ger enstaka falska 409:or, medvetet accepterat
- **Tid från Postgres:** `expires_at` räknas alltid med `now()` i databasen, aldrig i
  appservern eller klienten (`rules.md §4`)
- **Jittrat frisläpp:** innehavaren behåller exakt 5:00, men frisläppandet (`release_after`)
  sprids 0–20 s så att inte tusentals stolar blir lediga samma millisekund
- **Lazy expiry:** en utgången reservation frigörs också vid nästa försök mot samma stol,
  jämfört mot `release_after`
- **En aktiv reservation per kötoken:** `UNIQUE (queue_token_id) WHERE status IN ('active',
  'pending_payment')`. En ny reservation **ersätter** kötokenens egen aktiva (`active`) reservation
  i samma transaktion, så en övergiven eller utgången men ännu inte städad reservation aldrig låser ute
  användaren. En reservation i betalning rörs aldrig av en ny reservation (då svarar servern 409). `DELETE
  /events/:id/reservations/:reservationId` avbryter just den reservationen och släpper stolarna
  (bakåtpil, "Avbryt bokningen", avbrytsidan efter Stripe och kartan som släpper flikens senaste
  reservation). Har den gått vidare till Stripe utan att betalas låter servern först Stripe-sessionen gå
  ut och släpper stolarna bara om Stripe bekräftar `expired` (en utgången session kan aldrig betalas);
  betald session ger 409, ett Stripe som inte svarar ger 503 och inget ändras. Anropet är idempotent,
  begränsat till den egna kötokenen och tar
  reservations- och stollås med NOWAIT (lazy expiry låser i motsatt ordning, så ett väntande lås gav en
  ABBA-deadlock). Ett lås som inte går att ta ger 409 efter tre försök
- Värdena (reservationstid, jitter, max stolar) ligger i `config`-tabellen

### Betalning

- **Stripe testläge** (Checkout + webhooks) i produktion. Kortuppgifter når aldrig backend
- **`payment-mock`** i CI och lasttest, med kaos: latens, fel, dubbla och sena webhooks
- Servern räknar alltid totalen från stolsraderna. Summan som visas och summan som debiteras
  kommer från samma funktion (`services/pricing.ts`)

**Betalning som landar efter utgången reservation** är det enda stället där riktiga pengar
kan försvinna. Två mekanismer:

1. **Frysning (primär):** när Checkout skapas går reservationen till `pending_payment` och
   slutar räkna ner, med eget tak (`payment_frozen_until`). En aktiv Checkout per kötoken
2. **Automatisk återbetalning (skyddsnät):** kommer betalningen ändå för sent återbetalas den
   och ett förklarande mejl skickas

**Förlorad stol i en order:** förlorar en enskild stol racet mot `tickets`-constrainten
återbetalas just den stolen (Stripe partial refund) medan resten av ordern bekräftas. Krockar
alla stolar blir det full återbetalning.

**Webhooken:** raw body för HMAC-verifiering, undantagen från rate limiting, och "svara 200
snabbt": verifiera → dedupe på händelse-id → outbox → 200 → workern gör jobbet.

### Idempotens och meddelanden

- **Idempotensnycklar** på reservation och betalning: `UNIQUE (event_id, scope, key)` med
  sparat svar. `scope` är anroparens identitet (kötoken eller user-id), så ingen kan hämta
  någon annans sparade svar. Samtidiga försök medan den första fortfarande kör får **409**
- **Transactional outbox:** meddelandet skrivs i samma transaktion som ordern. Relayn bor i
  `scheduler-worker`, pollar båda shardarna och använder `FOR UPDATE SKIP LOCKED`
- **Idempotenta konsumenter**, efter konsekvens: pengar och biljetter via
  `processed_messages` (unique), notifikationer via Redis-set med TTL, QR-token naturligt
  idempotent (HMAC av `order_id` + `seat_id`)
- **RabbitMQ:** quorum-köer med delivery limit och **dead-letter-köer** (`tickets.dlx` →
  `<kö>.dead`). Konsumenten räknar själv försök (`x-acquired-count`) och nackar utan requeue på
  sista försöket. Larm till Slack när en dödkö inte är tom

---

## 5. Väntrum och botskydd

### Väntrum

- Redis ZSET per event. **Insläppstakt** (standard 300/min) och två tider, båda i `config` och
  ändringsbara live:
  - **Ingen längsta kötid:** man står kvar så länge det finns en chans till en plats.
    scheduler-worker tömmer kön med besked när försäljningen stänger (`sales_closed`) eller när
    eventet är slutsålt (`sold_out`: inga platser lediga eller hållna, en hållen plats kan komma
    tillbaka). `queue_session_total_minutes` finns kvar i `config` men läses inte längre
  - **Bokningsfönster** `queue_booking_window_minutes` (10 min): räknas från **insläppet**, inte från
    joinen, så en lång kötid äter aldrig upp bokningstiden. Slutdatumet sparas som värdet i
    `admitted:<event>:<token>` och förnyelsen klipps mot det
  - **Inaktivitet** `queue_session_inactivity_minutes` (10 min): förnyas vid aktivitet men aldrig förbi
    bokningsfönstret. Efter fönstret kan man inte längre reservera eller markera stolar och får ställa
    sig i kön igen. En redan gjord reservation och betalningen påverkas inte
- **Kötoken är signerad och stateless** (HMAC med `queue_token_id` + `exp`). Signaturen räcker
  för validering. `exp` sätts en gång vid join och räcker till `sales_close_at` + bokningsfönster +
  15 min för håll och betalningsfrysning. Redis används bara till revokering och aktivitet, så en
  Redis-omstart dödar inte försäljningen
- **Direktinsläpp:** är kön tom och färre än `queue_direct_admit_limit` (standard 1000) är
  insläppta släpps man in direkt. Avgörs atomärt i ett Lua-skript. Så fort någon väntar köar
  alla nya bakom (FIFO)
- **Stängt försäljningsfönster** (`sales_close_at` passerad) och **slutsålt** har var sitt tillstånd,
  både i `GET /queue/status` och som WebSocket-meddelande
- Ködjupet är en signal i Grafana och för skalningen

### Botskydd — adaptiv eskalering

1. **Rate limiting per IP** (Redis) — alltid på
2. **En aktiv reservation per kötoken** — alltid på (partiellt index)
3. **Proof of work** vid en svag signal: servern svarar `428` med en HMAC-signerad utmaning,
   webbläsaren löser den osynligt (~0,3 s). Varje lösning gäller en gång, för en IP och ett event
4. **Cloudflare Turnstile** vid stark eller upprepad signal. Fail-closed på nivå 2, påverkar
   aldrig nivå 0–1

Signalerna (join-volym per IP, joins per IP och event, saknad eller skriptad `User-Agent`,
globalt kötryck) räknas i Redis. IP-volymsignalerna räknas som **en** signal, så ett delat nät
(klassrum, CGNAT) ensamt ger högst proof of work. Allt styrs från `config` med en kill switch
(`challenge_enabled`). Lasttestet går förbi via en hemlig header som `loadtest-mode` sätter.

**Rätt klient-IP bakom Cloudflare:** ingress-nginx `use-forwarded-headers` +
`proxy-real-ip-cidr` = Cloudflares intervall, så `CF-Connecting-IP` bara litas på därifrån.
Annars räknas hela världen som en användare, eller så kan en angripare låsa ute någon annan.

---

## 6. Realtid

| Data | Mekanism |
|---|---|
| Arenakartans geometri | API med lång `Cache-Control`, cachad av Cloudflare |
| Stolarnas status | Polling var 2:a sekund, 1 s cache vid kanten. Anonym route, inga cookies, explicit Cache Rule i Terraform (`browser_ttl = respect_origin`, annars höjer zonens Browser Cache TTL `max-age=1` till 4 timmar) och `cache: 'no-store'` i klienten. Statusen bär `heldUntil` (när en aktiv reservation går ut) för nedräkningen vid klick på en upptagen stol |
| Sektionssammanfattning | `max-age=5` vid kanten |
| Eventlistan | 10 s cache i Redis (inte vid kanten, se forsvar.md) |

**WebSocket bara för ett-till-ett:** köplats, insläpp, "din stol togs". Klienten skickar sin
token som första meddelande (aldrig i URL:en). Heartbeat var ~30:e sekund, automatisk
återanslutning med backoff. Varje gateway-podd har **en** delad Redis-prenumeration (`ws:*`).

**WebSocket är en optimering, aldrig enda leveransvägen.** Redis Pub/Sub är fire-and-forget,
så varje WS-meddelande motsvaras av tillstånd klienten kan läsa om (`GET /queue/status`,
`GET /reservations/:id`).

### Redis — användning

| Användning | Hur |
|---|---|
| Väntrumskö | ZSET per event, köplats = rang |
| Kötoken-revokering | `revoked:<id>` |
| Markerade stolar | Set per kötoken + omvänt index, underlag för "din stol togs" |
| Statuscache | Stolsstatus per sektion |
| Rate limiting och botsignaler | INCR + EXPIRE |
| Notifikationsdedupe | Set med TTL |
| Pub/Sub | booking-api/scheduler-worker → gateway-poddarna |

AOF-persistens på. Allt annat än kön tål en omstart.

---

## 7. Databas

**Två Postgres-shardar**, shard-nyckel `event_id`. Routinglagret hashar, migrations och
backup körs mot båda. **Varje shardad tabell bär `event_id`.** Globala tabeller ligger på
shard-0. `orders.user_id` saknar FK, och "Mina biljetter" hämtas med scatter-gather.

**Globala (shard-0):** `users`, `venues`, `venue_sections` (med layout för kartöversikten),
`venue_seats`, `config`

**Shardade:**

```
events             id, venue_id, title, artist, category, starts_at, sales_open_at,
                   sales_close_at, status, image_url, description, featured
seats              id, event_id, venue_seat_id, section_id, row, number, ticket_number,
                   price_cents, status, reservation_id
                   UNIQUE (event_id, ticket_number)
reservations       id, event_id, queue_token_id, status, expires_at, release_after,
                   payment_frozen_until
                   UNIQUE (queue_token_id) WHERE status IN ('active', 'pending_payment')
orders             id, event_id, user_id, reservation_id (ingen FK), total_cents, status
payments           id, event_id, order_id, provider_ref, idempotency_key, amount_cents, status
tickets            id, event_id, order_id, seat_id, qr_token, status (valid|refunded|void)
                   UNIQUE (event_id, seat_id) WHERE status = 'valid'
ticket_scans       event_id, ticket_id, gate, scanned_by, scanned_at
                   UNIQUE (event_id, ticket_id)
idempotency_keys · processed_messages · outbox · waitlist
```

- **`UNIQUE (event_id, seat_id) WHERE status = 'valid'`** på `tickets` är den yttersta
  garantin mot översäljning. Partiell, så en återbetald biljett inte blockerar stolen för alltid
- **`seats.status` är lagrad** och uppdateras i samma transaktion som låser stolen. Invarianten
  `seats` ↔ `reservations` testas
- **`qr_token` är HMAC-SHA256** med serverhemlighet, går inte att tillverka eller avkoda.
  Scannern slår upp den inom eventets shard
- **Retention:** `reservations` rensas efter 30 dagar av ett timjobb i scheduler-worker (bara
  `converted`, `expired` och `cancelled`, i batcher om 1000). `outbox`, `processed_messages` och
  `idempotency_keys` ska rensas på samma sätt men är inte byggda
- **Migrationer är bara additiva** och körs före koden, så gammal kod fungerar mot ny databas

### Data in

- **Biljettnummer (CSV):** `import-tickets` i scheduler-worker validerar exakt 5 000 rader
  utan dubbletter och skriver `ON CONFLICT DO NOTHING`. Idempotent, körs per event, aldrig som
  en del av deployen. CSV:n antas ha en kolumn, parad positionellt mot arenans platser
- **Demo-events:** `seed-events-from-csv` läser `seed/venues.csv` och `seed/events.csv`
  (20 events, 5 arenor, bilder i `seed/images/`). Idempotent, validerar allt innan något skrivs
- **Lasttest:** eget event och egen arena med 5 000 platser. `reset-sale` nollställer det
  manuellt mellan körningar, aldrig automatiskt

---

## 8. Auth och säkerhet

### Auth

- **Inloggning först vid betalning** (Auth0). Kön och reservationen är anonyma och binds till
  kötoken
- **JWT** verifieras mot Auth0:s JWKS med låst algoritm och kontroll av `aud`, `iss`, `exp`.
  Tokens bara i `Authorization`-headern
- **Scannern:** vanlig Auth0-inloggning, permission `scan:tickets` via rollen `staff`
- **Grafana:** Auth0 OAuth, anonym åtkomst av
- **Webhook:** HMAC-signerad
- Ordrar och biljetter scopas alltid på inloggad användare (annans order ger 404)

### Hot och motåtgärder

| Hot | Motåtgärd |
|---|---|
| Översäljning | Partiellt unikt index på `tickets`, mätt med `oversell_prevented_total` |
| Denial of inventory | En aktiv reservation per kötoken, rate limiting, botskydd |
| Massuppköp | Max 5 stolar per bokning |
| Biljettförfalskning | `qr_token` är HMAC med serverhemlighet |
| Dubbelskanning | Unikt index på `ticket_scans (event_id, ticket_id)` |
| Prismanipulation | Servern räknar totalen från databasen |
| Förfalskad webhook / replay | HMAC över raw body, dedupe på händelse-id |
| PCI DSS | Stripe Checkout, kortuppgifter når aldrig backend |
| IDOR | Varje fråga scopas på autentiserat user-id |
| Mass assignment | Zod strict, body sprids aldrig rakt in i en skrivning |
| SQL injection / XSS / CSRF | Parameteriserad SQL / inget `dangerouslySetInnerHTML` / bearer-token i stället för cookies |

### Infrastruktur

- Hetzner-brandvägg: **bara 443 från Cloudflares intervall**, SSH bara från egen IP.
  **6443 är aldrig öppet publikt**, Kubernetes-API:t nås bara via Tailscale (lokal kubectl och CI)
- Datatjänsterna är ClusterIP, ingen publik exponering
- k3s `--secrets-encryption` på, deploy-jobbet körs bara på push till main
- Containrar: `runAsNonRoot`, read-only rotfilsystem, droppade capabilities. Undantag:
  Postgres-imagens entrypoint måste börja som root
- Hemligheter: GitHub Actions secrets → Kubernetes Secrets. gitleaks i pre-commit och CI.
  Terraforms statefil committas aldrig

### GDPR

IP-adresser och känsliga fält maskeras i loggarna (redaction på tre djup). PostHog är
cookielöst tills användaren godkänt, utan PII (`distinct_id` = Auth0 `sub`). Session replay är
maskerad och bara efter samtycke. Princip för radering: **anonymisering**, inte hård radering,
eftersom bokföringslagen kräver 7 års bevarande (GDPR art. 17(3)(b)).

---

## 9. Frontend

### Webbappen (`apps/web`)

- **Data:** TanStack Query (polling, cache, backoff, pausad polling i dold flik). Lokal state
  med `useState` + context
- **Designsystem:** Tailwind 4 + daisyUI 5, eget tema `tikknet` i `shared/ui-theme/theme.css`
  (delas med scannern). Bara ljust tema. Primär `#c30048`, ink `#161b24`. Inter för brödtext,
  Plus Jakarta Sans för rubriker, självhostade. Lucide-ikoner. Kontrasten testas automatiskt
- **Sidor:** startsida (karusell med utvalda events, kategorier, sök) → eventsida → kösida
  `/events/:id/queue` → arenaöversikt (SVG med sektioner, kortrutnät om layout saknas) →
  sektionsvy (SVG i `react-zoom-pan-pinch`) med bokningspanel → checkout → verifierad
  bekräftelse → Mina biljetter (QR i helskärm, fungerar offline)
- **Tillgänglighet:** allt nåbart med tangentbord (roving tabindex på stolarna), `aria-live`
  för kö och notiser, axe i både unit och e2e
- **Ingen affärsregel i frontend:** summor, priser, gränsen på 5 stolar och kölogiken kommer
  från backend
- **PostHog:** typad händelsekatalog i `shared/analytics`, proxy via `/ingest` i apex-Workern
  (mot adblock), kritiska händelser (`payment_succeeded`) skickas från servern. Feature flag
  `show_seats_left_badge` utvärderas bara efter samtycke

### Scannern (`apps/scanner`)

Vite + React, QR-läsning med `@zxing/browser`. Logga in → välj event och grind → kameravy.
`POST /scans` svarar alltid 200 med ett resultat (`ok`, `already_scanned`, `not_found`,
`refunded`, `void`) som visas i helskärm i 2,5 s. Ingen offline-kö. `/scans` är undantagen från
rate limitern eftersom grindarna ofta delar NAT-IP.

---

## 10. Infrastruktur

### Hetzner, Terraform och k3s

- **2× CPX22** (2 vCPU, 4 GB) i vardagen. **Demonoder** (CPX32) och **lastgeneratorer** är egna
  Terraform-resurser (`demo_node_count`, `loadgen_node_count`) som bara finns när de behövs
- **Terraform äger:** servrar, brandvägg, privat nätverk, Hetzner CSI och CCM, Cloudflare (DNS,
  Cache Rules, SSL-läge, Workers), R2, samt klusterkomponenter som sällan ändras (ingress-nginx,
  cert-manager, KEDA, kube-prometheus-stack, Loki, Alloy)
- **Terraform äger inte** applikationens manifest — de deployas vid varje merge
- **Certifikat:** cert-manager med DNS-01 via Cloudflare (egen smal DNS-token). Let's Encrypt
  staging tills kedjan var stabil. Cloudflare SSL-läge Full (strict)
- **Lagring:** `storageClassName` för Hetzner CSI explicit i varje StatefulSet, så en volym
  följer podden mellan noder
- **Disk:** `retentionSize` på Prometheus, retention på Loki, larm vid fylld volym
- Klustret kör k3s v1.31 (EOL upstream), uppgradering är nästa steg efter försvaret

**Namespaces:** `ticketing` · `data` · `observability` · `ingress-nginx` · `keda` · `cert-manager`

### Zero-downtime — kräver alla fyra

1. `readinessProbe` (`/health/ready`: Postgres och Redis nåbara). `livenessProbe`
   (`/health/live`) kontrollerar bara att processen lever
2. `maxUnavailable: 0`
3. `preStop`-hook + `terminationGracePeriodSeconds`
4. Graceful shutdown i appen (SIGTERM → sluta ta emot, slutför pågående, stäng pooler)

Plus automatisk återanslutning i WS-klienterna. `scheduler-worker` har `strategy: Recreate`
och ett advisory lock vid start, eftersom RollingUpdate annars kör två samtidigt.

### Autoscaling

- **booking-api:** HPA 70 % CPU, min 2, max 6 (det som ryms på två cpx22, se docs/loadtest-cpu-plan.md). `requests 250m`, `limits 500m`, så kurvan blir
  gradvis i stället för ett språng. `scaleDown.stabilizationWindowSeconds` är **300 s**: 60 s
  provades men skalade ner mitt i lasttestet och gav "connection reset". Sänks tillfälligt till
  60 s med `kubectl patch` före en demo och återställs efteråt
- **realtime-gateway:** HPA på minne, 2–4. Nedskalning utlovas inte
- **notification-worker:** KEDA på RabbitMQ-ködjup, 100 meddelanden/podd, 1–4
- **Nodnivå** skalas för hand via Terraform. Demonoderna provisioneras i förväg
- PodDisruptionBudget `maxUnavailable: 1` på enreplikstjänsterna

### Deploy

```
merge till main
  → lint, typecheck, unit, integration, Pact, e2e, systemtester
  → 6 images parallellt till GHCR
  → migrations-Job mot båda shardarna (avbryter deployen om det misslyckas)
  → kubectl apply (Kustomize production-overlay) → rollout status
  → deploy-frontend: webb + scanner + bilder till R2
```

Migrations körs aldrig som init-container. Det finns ingen staging-miljö.

---

## 11. Observability och backups

- **Prometheus** (kube-prometheus-stack) skrapar `/metrics` från alla tjänster via
  ServiceMonitors. Exporters för Postgres och Redis, RabbitMQ:s inbyggda plugin, ingress-nginx
  metrics, node-exporter, kube-state-metrics
- **Loki + Alloy** för loggar (larm om Alloy tappar loggrader)
- **Ingen tracing.** OpenTelemetry och Tempo togs bort efter lasttestet: de kostade för mycket CPU på
  två små noder (docs/loadtest-cpu-plan.md steg 1)
- **Sparsam loggning:** ingen rad per anrop, bara fel och anrop över 1 s. ingress-nginx access-logg är
  avstängd; antal anrop och svarstider finns i Prometheus
- **Mått:** RED per endpoint, affär (aktiva reservationer, ködjup, insläppstakt, sålda
  biljetter, konvertering), infrastruktur (anslutningar per shard, låskonflikter,
  RabbitMQ-ködjup, dödköer) och `oversell_prevented_total`
- **Dashboard "Autoscaling & lasttest":** repliker + last + CPU på samma tidsaxel,
  zero-downtime-rad (ingress-5xx, ready-repliker), deploy-annotationer
- **Larm:** Alertmanager → Slack
- **Backups:** nattlig `pg_dump` av båda shardarna till R2, 7 dagars historik. Återställnings-
  övningen är genomförd: RTO ≈ 3 s för hämtning och restore (plus några minuters manuellt
  arbete), RPO upp till 24 h. Point-in-time recovery väljs medvetet bort

---

## 12. Tester

| Lager | Verktyg | Vad |
|---|---|---|
| Unit | Vitest (+ Testing Library, vitest-axe) | Domänregler, komponenter, kontrast |
| Integration | Testcontainers (riktig Postgres, Redis, RabbitMQ) | Transaktioner, routes, konsumenter |
| Kontrakt | Pact, utan broker | web, scanner, payment-mock, köer och Redis-meddelanden mot sina providers |
| System | Vitest + `fetch` + läsande SQL, black-box | Hela flöden F1–F7 + invarianter |
| e2e | Playwright | Bokningsflödet mot riktig Auth0, tangentbord, mobil, a11y, scanner |
| Last | k6 | Se nästa avsnitt |

Täckning: 90 % på `shared/domain` och `shared/db`. Varje route har minst ett lyckat och ett
misslyckat fall.

**Testerna som bevisar systemet:**

1. **Kapplöpning** — 100 parallella försök på samma stol → exakt 1 lyckas
2. **Deadlock** — `[5,9]` och `[9,5]` samtidigt → båda slutförs
3. **Idempotens** — samma nyckel 10× parallellt → 1 × 200 + 9 × 409, exakt en order
4. **Outbox** — RabbitMQ nere under köp → meddelandet levereras när den kommer tillbaka

Plus invarianterna efter systemtesterna: sålda biljetter ≤ stolar, inget `ticket_number` i
mer än en giltig biljett, varje betald order har rätt antal biljetter, ingen såld stol utan
biljett.

---

## 13. Lasttest

Lastgeneratorer är Hetzner-maskiner som skapas med Terraform och rivs efteråt. Huvudkörningarna
går genom Cloudflare (`api.<domän>`), samma väg som riktiga besökare, så att Cloudflares TLS och
cache ingår i resultatet (docs/loadtest-cpu-plan.md steg 6). `deploy-under-load` och felsökning går
direkt mot ingress via `loadtest.<domän>`.
`scripts/loadtest-mode.sh on|off` växlar allt som bara ska gälla under test: allowlista för
generatorernas IP:n, betalningar till payment-mock, högre insläppstakt, fler payment-mock-
repliker, botskyddets undantag och `POSTHOG_ENABLED=false`.

| Scenario | Vad |
|---|---|
| `smoke` | Få VU, hela flödet fram till `paid` |
| `queue-storm` | 50 000 VU ansluter inom 60 s, mäter väntrummet |
| `normal-sale` | **Betygsgrundande.** 50 000 bokningsförsök jämnt över 15 min |
| `spike-sale` | **Betygsgrundande.** 50 000 försök över ca 6,5 min i tydliga toppar |
| `deploy-under-load` | 10 försök/s i 5 min, 0 fel krävs, två rollouter under körningen |
| `shard-failure` | Shard-1 dödas mitt under lasten |

Varje betygsgrundande körning ger en rapport (`generate-sale-report`): konfiguration,
svarstider, genomströmning, fel, slutförda köp och beviset att sålda biljetter ≤ 5 000 och att
inget biljettnummer finns i mer än en order. Rapporten tas **före** `reset-sale`.

**Resultat:**

| Körning | Utfall |
|---|---|
| `normal-sale` | 539 köp (2 695 biljetter), inga dubbla biljettnummer |
| `spike-sale` | 483 köp (2 415 biljetter), inga dubbla biljettnummer |
| `deploy-under-load` | 0 misslyckade av 22 978 requests, 0 ingress-5xx, booking-api 2 → 5 repliker |

De flesta försök slutar med ett korrekt 409 ("stolen redan tagen") eller väntar i kön, så alla
stolar säljs inte inom fönstret. Lärdomarna ligger i `infra/LASTTEST-NOTES.md`.

---

## 15. Demomanus för försvaret

**Före:** `kubectl patch` HPA:ns `scaleDown`-fönster till 60 s, `loadtest-mode on`,
`reset-sale`, demonoder och lastgeneratorer uppe.

1. **Appen:** startsida → event → kö → karta → välj stolar → reservation med nedräkning →
   betala → verifierad bekräftelse → QR-kod → skanna den i scannern (ok, sedan redan skannad)
2. **En merge:** push till main → pipeline → images → migrations-Job → rollout (eller visa en
   tidigare körning, deployen tar några minuter)
3. **Grafana:** RED-paneler, affärsmått, per-shard-vyer, `oversell_prevented_total`
4. **Lasttest:** starta `normal-sale`
5. **Under lasten:** booking-api skalar upp i en gradvis kurva, KEDA skalar notification-worker
6. **Deploy under lasten:** visa 0 misslyckade requests (k6 + ingress-5xx)
7. **Lasten slutar:** booking-api skalar ner igen
8. **Döda shard-1:** `kubectl delete pod` (aldrig en hel nod — Cloudflare Free gör ingen
   origin-healthcheck). Events på shard-0 fungerar vidare, podden startar om med sin volym
9. **Larm:** visa att det landar i Slack
10. **Backup:** visa återställningsövningen och RPO/RTO som medvetet val

**Efter:** återställ HPA-fönstret till 300 s, `loadtest-mode off`, riv lastgeneratorerna
(`loadgen_node_count = 0`).
