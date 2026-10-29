# Lasttest & infra — lärdomar (2026-10-28)

Snabb checklista + kända fallgropar. Läs detta INNAN nästa lasttestkörning.

## Förbättringar som måste göras (prioritetsordning)

1. **Fixa Loki/Alloy-autentiseringen.** `alloy` får `401 Unauthorized: no
   org id` på VARJE loggbatch mot Loki — NOLL loggar har sparats någon
   gång under hela lasttestningen, trots att Fas 4 (observability) är
   markerad klar. Sätt `X-Scope-OrgID` i Alloys `loki.write`-config
   (`infra/terraform/observability.tf`), eller stäng av Lokis
   `auth_enabled` om multi-tenancy inte behövs. Utan detta går det inte
   att felsöka ett lasttest i efterhand — all historik försvinner så
   fort en pod skalas ner.
2. **Utred `queue/join`s ~37–40% RIKTIGA fel** (inte väntan, ett faktiskt
   avslag). Gick inte att se statuskoderna denna gång (blockerad av #1).
   Kör om efter Loki-fixen och läs faktiska statuskoder i Grafana/Loki.
3. **Gör webhook-secret-steget svårare att glömma.** Hela "0 sålda
   biljetter"-dramat berodde på att `booking-api`s
   `STRIPE_WEBHOOK_SECRET` måste pekas om manuellt till `payment-mock`s
   secret inför varje lasttest (redan dokumenterat i en kommentar i
   `infra/k8s/base/payment-mock/deployment.yaml`, men lätt att missa —
   kostade flera timmar idag). Förslag: ett litet script
   (`scripts/loadtest-webhook-secret-sync.sh`) som gör `kubectl set env`
   automatiskt, eller ett steg i `tests/load/README.md`s "Köra ett
   scenario" som inte går att hoppa över av misstag.
4. **Fixa cloud-init dirmngr-racet permanent** (loadgen-VM:er, se nedan)
   — manuell workaround fungerar men är inte en riktig fix, har redan
   "fixats" en gång tidigare och kom tillbaka.
5. (Lägre prioritet) Be Hetzner höja Primary IP-gränsen (just nu 5
   totalt) om ni vill kunna ha extra demo-kapacitet OCH 2 loadgen-VM:er
   samtidigt i framtiden.

## Checklista innan ett lasttest (normal-sale/spike-sale)

0. **VIKTIGAST — `STRIPE_WEBHOOK_SECRET` på booking-api måste tillfälligt
   pekas om till `payment-mock`s secret**, annars blir 100% av betalningarna
   aldrig bekräftade (401 på varje webhook, 0 sålda biljetter — såg ut som
   last-krasch men var bara detta). Redan dokumenterat i
   `infra/k8s/base/payment-mock/deployment.yaml` men lätt att missa:
   ```sh
   MOCK_SECRET=$(kubectl get secret tickets-generated-secrets -n ticketing -o jsonpath='{.data.payment-mock-webhook-secret}' | base64 -d)
   kubectl set env deployment/booking-api -n ticketing STRIPE_WEBHOOK_SECRET="$MOCK_SECRET"
   ```
   Verifiera ALLTID med `smoke.js` efteråt (ska ge `checks: 100.00%` OCH
   riktiga `paid`-ordrar i DB, inte bara k6:s "checkout: 201") innan en
   stor körning. **Återställ efteråt:**
   `kubectl set env deployment/booking-api -n ticketing STRIPE_HOST- STRIPE_PORT- RATE_LIMIT_ALLOWLISTED_IPS- && kubectl set env deployment/booking-api -n ticketing --from=secret/tickets-app-secrets --keys=stripe-webhook-secret`
   (INTE `kubectl apply -f` på base-filen — den har `image: …:latest` och skulle byta
   bort den pinnade imagen, och kan krocka med den överskrivna env-variabeln.)
1. **`terraform.tfvars`**: `demo_node_count` och `loadgen_node_count` måste stå
   för vad som FAKTISKT finns i molnet, annars tar nästa `terraform apply`
   (även med `-target` för något helt annat) bort dem för att stämma av mot
   default (`0`). Kolla verkligheten först: `terraform output -json loadgen_ipv4s demo_worker_ipv4s`.
2. **Rate limiter-allowlistning** måste matcha de AKTUELLA loadgen-IP:erna:
   ```sh
   kubectl set env deployment/booking-api -n ticketing RATE_LIMIT_ALLOWLISTED_IPS="<ip1>,<ip2>"
   ```
   Glöm inte ta bort den igen efteråt (`RATE_LIMIT_ALLOWLISTED_IPS-`).
3. **`queue_admission_rate_per_minute`** (config-tabell, shard 0):
   - normal-sale: ~3600 (precis över 56/s)
   - spike-sale: betydligt högre, min. 24000 (precis över toppens 337/s) —
     annars ackumuleras en obegränsad kö redan i första toppen.
4. **Event måste vara nollställt** (`reset-sale`) innan en ny körning —
   kör `generate-sale-report` INNAN `reset-sale`, aldrig efter (se nedan).
5. **k6 måste faktiskt vara installerat** på loadgen-VM:erna — se cloud-init-
   buggen nedan, verifiera med `ssh root@<ip> "k6 version"` innan körning.

## Terraform — fallgropar

- **`-target` skyddar INTE** andra resurser från att reconcilas mot sina
  default-värden i variables.tf. Sätt alltid `demo_node_count`/
  `loadgen_node_count` explicit i `terraform.tfvars` FÖRE någon apply, även
  en som bara targetar en annan resurs.
- **ALLA variabler utan default krävs vid varje apply**, oavsett `-target`
  (terraform parsar hela filen). Om du inte har riktiga värden för t.ex.
  `grafana_auth0_client_id/secret`, `slack_webhook_url` och du kör med
  `-target` mot en resurs som inte bryr sig om dem — skicka in påhittade
  platshållarvärden, det är säkert så länge targeten inte rör de resurserna.
- Riktiga secrets (hcloud, cloudflare, tailscale) finns i
  `tests/e2e/.env.local` under andra variabelnamn än `TF_VAR_*` (utom
  `TF_VAR_CLOUDFLARE_DNS_TOKEN` som redan är prefixad).
- **Hetzner-kontots Primary IP-gräns är 5 servrar totalt.** Kontrollplan +
  2 workers + 2 loadgen = redan 5. Vill man ha extra demo-kapacitet också
  måste man be Hetzner höja gränsen (support, inte instant) — annars går
  det inte att ha både demo-workers och 2 loadgen samtidigt.
- Kör alltid `terraform plan -target=...` och läs HELA diffen (särskilt
  "will be destroyed") innan `apply`. Brandväggsregel-diffar som visar
  "ta bort alla regler + lägg till alla regler igen" är en ofarlig
  ordnings-/representationskvirk i hcloud-providern, inte en riktig ändring
  — jämför bara att samma IP:er/portar finns i båda halvorna.
- Server-recreate (destroy+create) återanvänder ofta samma publika IP →
  SSH `known_hosts`-konflikt ("REMOTE HOST IDENTIFICATION HAS CHANGED").
  Fix: `ssh-keygen -R <ip>` innan ny ssh/scp.

## Cloud-init — känd race condition (loadgen-VM:er)

`cloud-init/loadgen.yaml.tftpl` har `dirmngr` i `packages:`, men `runcmd:`s
gpg-keyserver-steg kan ändå hinna köra innan dirmngr är klart installerat
→ `gpg: can't connect to the dirmngr` → k6-repots nyckel importeras aldrig
→ `E: Unable to locate package k6`. Detta har hänt två gånger trots en
tidigare "fix"-commit. Snabbaste lösningen just nu (inte en permanent fix):
kör manuellt på varje ny loadgen-VM:

```sh
ssh root@<ip> "apt-get install -y dirmngr && \
  gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
    --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69 && \
  echo 'deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main' > /etc/apt/sources.list.d/k6.list && \
  apt-get update && apt-get install -y k6"
```

Verifiera med `cloud-init status --long` — om `status: error` med
`scripts_user`/`runcmd`-fel, det är den här buggen.

## Kluster — kända kapacitetsgränser (noder är cpx22, 2 vCPU)

- **RabbitMQ**: höjd från 500m/256Mi → 1000m/768Mi
  (`infra/k8s/base/rabbitmq/statefulset.yaml`). Under den gamla gränsen
  blev podden OOM-killad under last (11 omstarter på en normal-sale-körning).
- **ingress-nginx**: höjd från 500m/256Mi → 1000m/512Mi
  (`infra/terraform/helm.tf`, `helm_release.ingress_nginx`). Samma
  OOM-mönster, syns som "connection refused" mot EN av klustrets tre
  publika IP:er (DNS round-robin rakt mot nod-IP:er, ingen LB) eftersom
  bara den noden kraschar.
- **RabbitMQ `.erlang.cookie`-rättighetsbugg**: när podden tvingas till en
  ny nod (t.ex. efter en resursändring) kan `fsGroup`-ommonteringen göra
  cookie-filen gruppläsbar → RabbitMQ 4 vägrar starta ("must be accessible
  by owner only"). Löst med en initContainer som kör
  `chmod 400 /var/lib/rabbitmq/.erlang.cookie` före huvudcontainern.
- Om en StatefulSet-pod hamnar i CrashLoopBackOff och en `kubectl apply`
  med ny podspec inte uppdaterar den (väntar för evigt på att den gamla
  ska bli Ready först): `kubectl delete pod <namn> -n <ns>` tvingar fram
  nyskapande med den nya specen. Data i PVC:n överlever.
- booking-apis HPA (`infra/k8s/base/booking-api/hpa.yaml`):
  `stabilizationWindowSeconds: 300` på scaleDown (INTE 30 — det gjorde
  skalningen instabil, fixat och bekräftat permanent).

## Rapportgenerering — ordning spelar roll

`generate-sale-report` läser BÅDE k6:s `--summary-export`-fil OCH
`orders`/`tickets`-tabellerna i DB. `reset-sale` RADERAR de tabellraderna.
Kör alltså ALLTID i denna ordning:
1. `k6 run --summary-export=/tmp/k6-summary.json ...`
2. vänta tills RabbitMQ-kön är tom (`rabbitmqctl list_queues name messages`)
3. `generate-sale-report -- <eventId> <scenario> /tmp/k6-summary.json <sekunder> /tmp/report.json`
4. **sen** `reset-sale -- <eventId>`

Kör man reset-sale före rapporten är den körningens data oåterkalleligt
borta.

## Lokal DB-åtkomst för scheduler-worker-script (reset-sale m.fl.)

Kräver port-forward + env (`DATABASE_URL_SHARD_0`, `DATABASE_URL_SHARD_1`,
`REDIS_URL`) — se `.env.example` för formatet. Lösenord hämtas live:
```sh
kubectl port-forward -n data svc/postgres-shard-0 5432:5432 &
kubectl port-forward -n data svc/postgres-shard-1 5452:5432 &
kubectl port-forward -n data svc/redis 6379:6379 &
export PGPASS0=$(kubectl get secret postgres-shard-0-credentials -n data -o jsonpath='{.data.password}' | base64 -d)
export PGPASS1=$(kubectl get secret postgres-shard-1-credentials -n data -o jsonpath='{.data.password}' | base64 -d)
export DATABASE_URL_SHARD_0="postgresql://postgres:${PGPASS0}@localhost:5432/tickets"
export DATABASE_URL_SHARD_1="postgresql://postgres:${PGPASS1}@localhost:5452/tickets"
export REDIS_URL="redis://localhost:6379"
```

**OBS sharding**: `config`-tabellen (global) ligger bara på shard 0.
`seats`/`orders`/`tickets` etc. är per EVENT hashat till shard 0 ELLER 1
(`shared/db/src/shard-router.ts`) — kolla rätt shard innan du drar
slutsatser av en tom queryträff.

## Körning 2026-10-28 — spike-sale (första giltiga körningen, ingen infra-krasch)

**Resultat (k6, båda maskinerna ihop):** ~48 800 iterationer, 6m30s,
`checks_failed` ~38% — men `reservations`-checken räknar "stolen redan
tagen" (409) som godkänt, så den siffran överdriver de RIKTIGA felen.

**VIKTIGT — k6:s "checkout: 201" ljuger om vad som faktiskt hände.**
k6 visade ~600 "lyckade" checkout-anrop, men `generate-sale-report` (den
RIKTIGA sanningen, direkt mot DB) visade **`completedPurchaseCount: 0`,
`soldTicketCount: 0`**. "201 på checkout" betyder bara att ORDERN
skapades, inte att betalningen bekräftades (det sker asynkront via
`payment-mock`s webhook-anrop tillbaka till booking-api, samma mönster
som riktiga Stripe).

**ROTORSAK HITTAD OCH BEKRÄFTAD (inte last-relaterad alls):** payment-mocks
webhook-leveranser fick 401 på VARJE enda försök
(`kubectl logs <payment-mock-pod> | grep webhook` — "got a non-2xx
response", status 401, på alla 4 poddarna). Orsak: signaturen matchar
aldrig, eftersom `payment-mock` signerar med
`tickets-generated-secrets/payment-mock-webhook-secret` men
`booking-api` verifierar mot `tickets-app-secrets/stripe-webhook-secret`
(den RIKTIGA Stripe-secreten) — två helt olika värden. **Detta är redan
dokumenterat** som ett manuellt steg i en kommentar i
`infra/k8s/base/payment-mock/deployment.yaml` (rad 45-50) som vi bara
missade göra. Skalningen av `payment-mock` (4 repliker) var alltså
ONÖDIG för att lösa DETTA problem (kan fortfarande vara bra att ha av
andra skäl, se nedan) — den riktiga fixen:

```sh
MOCK_SECRET=$(kubectl get secret tickets-generated-secrets -n ticketing -o jsonpath='{.data.payment-mock-webhook-secret}' | base64 -d)
kubectl set env deployment/booking-api -n ticketing STRIPE_WEBHOOK_SECRET="$MOCK_SECRET"
# ... kör lasttestet ...
# återställ efteråt (inte kubectl apply -f på base-filen, se checklistan överst):
kubectl set env deployment/booking-api -n ticketing STRIPE_HOST- STRIPE_PORT- RATE_LIMIT_ALLOWLISTED_IPS-
kubectl set env deployment/booking-api -n ticketing --from=secret/tickets-app-secrets --keys=stripe-webhook-secret
```

**Verifierat med `smoke.js` efter fixen:** 9 av 10 checkouts blev
`paid` (1 `pending`, matchar den avsiktliga ~5% simulerade
betalningsmisslyckande-chansen i `chaos-config.ts`). Fixen fungerar.

**GILTIG SLUTRAPPORT (`/tmp/report-spike-sale-final.json`):** 483
genomförda köp, 2415 sålda biljetter (inom 5000-lagret), inga
dubblett-biljettnummer. Detta är den betygsgrundande rapporten för
spike-sale — klar.

**`normal-sale` kördes också om efteråt (samma webhook-secret-fix kvar),
giltig rapport (`/tmp/report-normal-sale-final.json`):** 539 genomförda
köp, 2695 sålda biljetter, inom lagret, inga dubbletter. BÅDA
betygsgrundande testerna har nu giltiga rapporter. 2026-10-28, klart.

### Hittade problem, med orsak

1. **Loggning (Loki) har varit helt trasig under hela testet** —
   `alloy`-podden får `401 Unauthorized: no org id` på VARJE batch mot
   Loki (`kubectl logs -n observability -l app.kubernetes.io/name=alloy`).
   Loki kör med multi-tenant auth påslaget (`auth_enabled`) men Alloys
   `loki.write`-komponent skickar ingen `X-Scope-OrgID`-header. **Resultat:
   NOLL loggar har någonsin sparats i Loki**, trots att Fas 4 är markerad
   "klar efter review". Måste fixas FÖRE nästa körning — annars går det
   inte att se vilka statuskoder `queue/join`/`checkout` faktiskt gav vid
   fel (kortlivade HPA-uppskalade pods tar sina `kubectl logs` med sig när
   de skalas ner, Loki är enda sättet att se dem i efterhand).
   **Fix:** sätt `X-Scope-OrgID` i Alloys `loki.write`-endpoint-config
   (`infra/terraform/observability.tf`), eller stäng av `auth_enabled` i
   Loki om multi-tenancy inte behövs.

2. **`payment-mock` är en enda replik, 200m CPU/128Mi** — medan
   `booking-api` skalar till 10 repliker under samma spik. BEKRÄFTAD
   (inte bara misstänkt) orsak till att 0 av 1405 ordrar blev betalda —
   se ovan. En enda liten pod hann uppenbarligen aldrig leverera
   webhook-bekräftelserna för lasten.
   **Fix (beslutat):** INGEN HPA på `payment-mock` — i verkligheten är
   det Stripe som hanterar sin egen skalning, `payment-mock` är bara en
   lokal ersättare för det. Skala den STATISKT (manuellt) till fler
   repliker + högre CPU-gräns precis innan ett lasttest, skala tillbaka
   till 1 efteråt — samma mönster som loadgen/demo-workers (temporär
   kapacitet för testets skull, inte en permanent arkitekturändring):
   ```sh
   kubectl scale deployment/payment-mock -n ticketing --replicas=4
   # ... kör testet ...
   kubectl scale deployment/payment-mock -n ticketing --replicas=1
   ```

3. **Alla k6-scenarier kör mot ETT `EVENT_ID`** → alla skrivningar
   (reservationer/ordrar/betalningar) koncentreras till EN enda
   Postgres-shard, inte utspritt över båda (dokumenterat, avsiktligt
   designval för testets enkelhet — se docs/runbook.md "shard-failure").
   Bra att känna till: den shardens kapacitet är den verkliga gränsen i
   det här testet, inte systemets totala DB-kapacitet.

4. **`queue/join` hade ~37% riktiga fel** (inte bara väntan) — orsak
   okänd i dagsläget eftersom (1) blockerar oss från att se statuskoder.
   Kör om efter (1) är fixat och läs faktiska statuskoder innan vidare
   gissningar.

### Att göra innan nästa körning
- [ ] Fixa Loki/Alloy-autentiseringen (INTE gjort än — nästa körning har
      fortfarande ingen loggdata att felsöka med)
- [x] Skala `payment-mock` statiskt till 4 repliker/500m CPU (gjort) —
      **glöm inte skala tillbaka till 1/200m efter sista körningen**
- [x] Kört `generate-sale-report` på spike-sale-körningen innan reset
      (`/tmp/report-spike-sale.json`) — bekräftade 0 sålda
- [ ] Kör om spike-sale, kolla `orders`-status igen efteråt (inte bara
      k6:s "checkout: 201") för att bekräfta att payment-mock-fixen funkar
- [ ] Kör `normal-sale` också (dess rapport gick förlorad tidigare idag,
      kör generate-sale-report INNAN reset denna gång)
