# Runbook — vad vi gör när något går fel

Fylls i under Fas 4 (backup/restore-övningen) och Fas 7. Ska svara på den
muntliga frågan "Driften: backups, och vad ni gör när något går fel."

## Backup-lagring: Cloudflare R2 (Fas 4)

`postgres-backup`-CronJobben (`infra/k8s/base/backup/cronjob.yaml`) laddar upp till
Cloudflare R2 via `rclone`, konfigurerat helt via miljövariabler (ingen config-fil).
Krediterna kommer från fyra GitHub repo-secrets, skapade av
`.github/workflows/deploy.yml` (samma mönster som `tickets-app-secrets`) — se
"Nödvändiga GitHub Actions-secrets" nedan.

**Engångssteg i Cloudflare-dashboarden** (du gör detta manuellt, en gång):

1. **R2 → Create bucket** — namn t.ex. `tickets-backups`.
2. **Manage R2 API Tokens → Create API Token** — typ "R2 Token", behörighet
   **Object Read & Write**, scope: **endast** den nya bucketen (samma princip som de
   två Cloudflare-tokens i `docs/adr/0004-split-cloudflare-tokens.md` — en bred token
   som även kan göra DNS/cache-ändringar hör inte hemma i en backup-CronJob).
3. Spara **Access Key ID**, **Secret Access Key**, **Account ID**, och bygg endpointen:
   `https://<account-id>.r2.cloudflarestorage.com`.
4. Lägg dessa fyra som GitHub repo-secrets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_ENDPOINT` (steg 3:s URL), `R2_BUCKET` (bucketnamnet från steg 1).

## Frontend-proxy-Workern (Fas 5)

`deploy-frontend`-jobbet laddar bara upp filerna till R2 — det kopplar INGET till
apex-domänen. Utan `infra/terraform/cloudflare-frontend.tf` (en Cloudflare Worker som
läser bucketen via en R2-binding och faller tillbaka till `index.html` för
klientsidig routing) saknar `<domän>` helt en DNS-post: `ERR_NAME_NOT_RESOLVED`,
hittat live efter den första riktiga deployen. En vanlig R2 "Custom Domain" dög inte
— den gör hela bucketen publik, inklusive databas-backuperna.

**Engångssteg innan `terraform apply`:**

1. **Cloudflare-dashboarden → ditt API-token (samma som `cloudflare_api_token`) →
   Edit → lägg till behörigheten `Account | Workers Scripts | Edit`** (utöver
   DNS/Zone Settings/Cache Rules den redan har).
2. Sätt två nya Terraform-variabler (ingen av dem är en hemlighet, men hör inte
   hemma i en committad `.tfvars` ändå — samma `terraform.tfvars` som `domain_name`):
   - `cloudflare_account_id` — samma **Account ID** du sparade i steg 3 ovan.
   - `r2_bucket_name` — **måste** vara exakt samma sträng som GitHub-secreten
     `R2_BUCKET`, annars pekar Workern och `rclone`-uploaden på olika buckets.
3. `terraform apply`. Om det failar på just `cloudflare_workers_script`-resursen med
   ett behörighetsfel specifikt för R2-bindingen (inte bara scriptet självt), testa
   att även lägga till `Account | Workers R2 Storage | Edit` på samma token — det är
   overifierat om Workers Scripts-behörigheten ensam räcker för en R2-binding.

## cdn-Workern: `cdn.<domän>` (Fas 7)

`cdn.<domän>` serveras av en egen Worker (`infra/terraform/workers/cdn-proxy.js`) som läser
samma R2-bucket som frontenden, men **bara** nycklar under `images/` och `brand/` — allt
annat ger 404. Bucketen innehåller även databas-backuperna, så vitlistan är en
säkerhetsgräns (testas av `infra/terraform/workers/cdn-proxy.test.js` i CI). Lägg aldrig
till ett prefix utan att kolla vad mer som ligger under det.

Samma Cloudflare-token-behörigheter som frontend-proxy-Workern räcker. `deploy-frontend`
laddar upp `apps/web/public/brand/` till `brand/`; eventbilderna (`images/`) laddas upp av
seed-steget (docs/plan.md 7.6). Filnamnen är inte versionerade, så cachen är
`max-age=86400` och inte `immutable`: en ändrad fil kan ta upp till ett dygn att nå ut.

**Verifiering efter `terraform apply` och en deploy:**

```sh
curl -I https://cdn.tikknet.se/brand/tikknet-icon.svg   # 200 + cache-control: public, max-age=86400
curl -I https://cdn.tikknet.se/backups/                 # 404
curl -I https://cdn.tikknet.se/frontend/index.html      # 404
curl -I --path-as-is https://cdn.tikknet.se/brand/../backups/x   # 404
```

## Grafana-inloggning via Auth0 (Fas 4)

Grafana (`https://grafana.<domän>`, se `infra/terraform/observability.tf`) loggas in
via en **egen** Auth0-"Application" — skild från booking-apis, eftersom den har andra
callback-URL:er och inte ska dela klient-hemlighet med API:et.

1. Auth0 dashboard → **Applications → Create Application → Regular Web Application**,
   namn "Grafana".
2. **Allowed Callback URLs:** `https://grafana.<domän>/login/generic_oauth`
3. **Allowed Logout URLs:** `https://grafana.<domän>/login`
4. Spara **Domain**, **Client ID**, **Client Secret** → sätt som Terraform-variabler
   (`TF_VAR_grafana_auth0_domain`, `TF_VAR_grafana_auth0_client_id`,
   `TF_VAR_grafana_auth0_client_secret`), aldrig i en committad `.tfvars`.

Break-glass: ett admin-konto genereras av Terraform (`random_password.grafana_admin`,
lagrat bara i `kubernetes_secret.grafana_admin` och Terraform-statefilen) ifall
Auth0-anslutningen går ner. Hämta lösenordet vid behov med:

```
kubectl get secret grafana-admin-credentials -n observability -o jsonpath='{.data.admin-password}' | base64 -d
```

## Slack-larm (Fas 4)

1. Slack → skapa en **Incoming Webhook** (en Slack-app, eller `api.slack.com/apps` →
   Incoming Webhooks) kopplad till kanalen `#tickets-alerts`.
2. Sätt URL:en som `TF_VAR_slack_webhook_url`.

Alertmanager-reglerna ligger i `infra/terraform/observability.tf`
(`alertmanager.config`), alertregler i `infra/k8s/base/monitoring/prometheusrule.yaml`.
**Enklast att utlösa live under försvaret:** `kubectl delete pod` på en
postgres-shard-podd → `PostgresDown` (postgres-exporter tappar kontakten) feedbackar i
Slack inom ~1 minut; eller tillfälligt skala en deployment till 0 repliker → `HighErrorRate`.

## Återställning av databas (Fas 4)

**Dumparna skapas nattligt** (CronJobben ovan), namngivna
`postgres/shard-<N>-<ISO8601-tidsstämpel>.dump` i R2-bucketen, `pg_dump -Fc`
(komprimerat, egen binärformat — `pg_restore`, inte `psql`, återställer dem).

**Genomför övningen i en tillfällig Postgres-podd, ALDRIG mot en shard i drift** —
`docs/rules.md §12` förbjuder att köra migrations mot produktion, samma princip
gäller en restore som skriver över data. Podden ligger i namnrymden `data`, har ingen
Service och ingen PVC, och tas bort efteråt. Ta tid på varje steg (`time` eller klockan).

```bash
# 1. Starta en TOM, tillfällig Postgres (egen podd, inte en riktig shard):
kubectl -n data run restore-test --image=postgres:17-alpine --restart=Never \
  --env=POSTGRES_PASSWORD=test -- postgres
kubectl -n data wait --for=condition=Ready pod/restore-test --timeout=120s
until kubectl -n data exec restore-test -- pg_isready -h 127.0.0.1; do sleep 2; done  # TCP = riktiga servern, inte initdb

# 2. Hämta senaste dumpen för shard 0 från R2 (lokalt, med R2-nycklarna som env-vars):
export AWS_ACCESS_KEY_ID=<R2 access key>
export AWS_SECRET_ACCESS_KEY=<R2 secret key>
latest=$(aws s3 --endpoint-url https://<account-id>.r2.cloudflarestorage.com \
  ls s3://<bucket>/postgres/ | grep shard-0 | sort | tail -1 | awk '{print $4}')
echo "$latest"   # tidsstämpeln i namnet = RPO-underlaget (hur gammal är dumpen?)
aws s3 --endpoint-url https://<account-id>.r2.cloudflarestorage.com \
  cp "s3://<bucket>/postgres/$latest" ./restore-test.dump

# 3. Återställ i podden:
kubectl -n data cp ./restore-test.dump restore-test:/tmp/restore-test.dump
kubectl -n data exec restore-test -- pg_restore -U postgres -d postgres --create --clean \
  --if-exists /tmp/restore-test.dump

# 4. Verifiera. Antal events/ordrar/biljetter, samt kronjuvel-queryn (docs/plan.md "Tester"):
kubectl -n data exec restore-test -- psql -U postgres -d tickets -c \
  "SELECT (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM tickets) AS tickets;"
kubectl -n data exec restore-test -- psql -U postgres -d tickets -c \
  "SELECT count(*) FROM tickets WHERE status='valid'; SELECT count(DISTINCT seat_id) FROM tickets WHERE status='valid';"
# De två sista talen ska vara lika — ingen stol har mer än en giltig biljett.

# 5. Städa bort den tillfälliga podden och dumpen:
kubectl -n data delete pod restore-test
rm ./restore-test.dump
```

**Tidtagning (RPO/RTO) — fyll i vid faktisk körning:**

| Steg | Tid |
|---|---|
| Hitta + hämta senaste dumpen (RPO-underlag — hur gammal är den?) | _ej körd än_ |
| `pg_restore` + verifiering (RTO-underlag) | _ej körd än_ |

RPO är i praktiken **upp till 24 timmar** (nattlig dump, inget kontinuerligt WAL-arkiv)
— ett medvetet val, inte en brist: `docs/plan.md` kräver inte point-in-time recovery
(se "Flyttat till efter inlämningen"), och 24h RPO för en biljettdatabas där varje
transaktion redan är beroende av Postgres' egna ACID-garantier under drift är rimligt
för en examinationsuppgift. En skarp produktion med riktiga pengar hade motiverat WAL-
arkivering (RPO i minuter) — se `docs/forsvar.md` om frågan kommer upp i försvaret.

## Vanliga larm och vad de betyder (Fas 4)

Larmreglerna: `infra/k8s/base/monitoring/prometheusrule.yaml`.

| Larm | Betyder | Första åtgärd |
|---|---|---|
| `HighErrorRate` | >5% av en tjänsts requests svarar 5xx över 5 min | `kubectl logs` på tjänsten, kolla senaste deploy |
| `PostgresDown` | `pg_up == 0` — postgres-exporter når inte databasen | `kubectl get pods -n data`, kolla om shard-podden crashat |
| `RabbitMQQueueDepthHigh` | En kö har >900 väntande meddelanden (KEDAs tak är 1000 = 100/podd × 10 poddar, Fas 6) | Kolla om notification-worker hänger eller RabbitMQ är nere |
| `PodCrashLooping` | >3 omstarter av en container på 15 min | `kubectl describe pod`, läs `Last State: Terminated` -reason |

## Shard nere (Fas 6)

**Döda ALDRIG en hel nod** — bara podden (docs/plan.md "Demomanus"):
Cloudflare Free gör inga origin-healthchecks, så en död nod hade fått
~halva trafiken att fortsätta gå dit och få 5xx tills `terraform apply`
hunnit köra. Poddnivå räcker för att visa samma sak utan den risken.

```sh
kubectl delete pod -n data -l app=postgres-shard-1 --grace-period=0 --force
```

**Vad som ska hända:** `events-service.ts`s `listAllEvents` och
`my-tickets-service.ts`s `listMyTickets` (`Promise.allSettled` över båda
shards) degraderar till ett partiellt resultat + en loggad varning för
den nedgångna shardens anrop — aldrig ett 500 för hela listan. Nya
bokningsförsök mot ett event på shard-0 fortsätter fungera obrutet;
försök mot ett event på shard-1 får fel (väntat, det ÄR nere) tills
podden schemaläggs om (Kubernetes gör detta automatiskt, nätverksvolymen
— Hetzner CSI — följer med till den nya noden).

**Återställning:** inget manuellt steg krävs utöver att vänta —
StatefulSet:et skapar om podden, PVC:n (Hetzner CSI, nätverksvolym)
monteras om med datan intakt. Verifiera med
`kubectl get pods -n data -l app=postgres-shard-1 -w`.

**Under `shard-failure`-scenariot** (tests/load/shard-failure.js): kör
kommandot ovan ungefär halvvägs in i körningen. Alla k6-scenarier kör
mot ETT `EVENT_ID` (upptäckt i Fas 6-reviewn: "bara de försök som
hashade till shard-1 påverkas" går alltså INTE att observera i denna
körning — hela eventet ligger på en enda shard, så antingen påverkas
ALLA försök eller INGA, beroende på vilken shard just det eventet
hashar till). Vill du visa att den ANDRA shardens events fortsätter
fungera obrutet, kör mot två olika `EVENT_ID` (ett per shard — se vilken
shard ett givet id hashar till via `shared/db/src/shard-router.ts`s
`hashEventIdToShardIndex`) och jämför rapporterna för de två.

## Lasttest: `loadtest-mode` (Fas 7)

`scripts/loadtest-mode.sh on|off` växlar allt som medvetet **inte** är permanent i git
(docs/plan.md 7.1), så inget manuellt steg kan glömmas. Kräver `kubectl` mot klustret
(Tailscale), `jq` och terraform initierat i `infra/terraform`.

```sh
scripts/loadtest-mode.sh on [admission_rate_per_minute]   # default 3600 (spike-sale: minst 24000)
scripts/loadtest-mode.sh off
```

`on` sätter: loadgen-IP:erna i `RATE_LIMIT_ALLOWLISTED_IPS`, `STRIPE_HOST`/`STRIPE_PORT`
mot payment-mock och `STRIPE_WEBHOOK_SECRET` till mockens secret (via stdin, aldrig som
argument), `queue_admission_rate_per_minute` i config-tabellen på shard 0, och 4
payment-mock-repliker. Det skriver sedan ut smoke-kommandot och DB-kontrollen (ordrarna ska
bli `paid`, inte bara 201 från checkout). Kör alltid smoke innan en stor körning.

`off` tar bort överskrivningarna, återställer `STRIPE_WEBHOOK_SECRET` till sin
`secretKeyRef` (JSON-patch på env-indexet), sätter insläppet till 300 och payment-mock
till 1 replik, och avslutar med samma server-dry-run som CI:s `k8s-dry-run`. Lämnas en
literal `STRIPE_WEBHOOK_SECRET` kvar failar nästa deploy ("valueFrom may not be specified
when `value` is not empty").

Scriptet rör inte terraform: sätt `loadgen_node_count` tillbaka till 0 och kör
`terraform apply` själv efteråt, så loadgen-VM:erna inte kostar pengar.

## Lasttest: allowlista generatorernas IP:n i rate limitern (Fas 6)

> Sedan Fas 7 görs detta av `scripts/loadtest-mode.sh` (se ovan). Stegen nedan är kvar som
> bakgrund till motiveringen.

`services/booking-api/src/routes/rate-limit.ts`s `RATE_LIMIT_ALLOWLISTED_IPS`
(docs/plan.md "Lasttest": "Lastgeneratorernas CF-verifierade adresser
allowlistas i rate limitern under testet, med dokumenterad motivering")
— utan den mäter `normal-sale`/`spike-sale`/`queue-storm` vårt eget
botskydd (429:or) i stället för systemet, eftersom alla VU:er på en
generator-VM delar samma källIP.

**Motivering:** adresserna är lastgeneratorernas EGNA, kända IP:n
(`hcloud_server.loadgen`, aldrig en header en klient kan förfalska —
samma princip som `CF-Connecting-IP`-litandet, docs/plan.md "Botskydd").
Allowlistningen är TILLFÄLLIG, bara under den faktiska körningen.

```sh
# 1. Hämta generatorernas IP:er
terraform -chdir=infra/terraform output -json loadgen_ipv4s

# 2. Sätt dem (kommaseparerat) på booking-api, EN gång innan körningen
kubectl set env deployment/booking-api -n ticketing \
  RATE_LIMIT_ALLOWLISTED_IPS="1.2.3.4,5.6.7.8,9.10.11.12"

# 3. ALLTID efteråt — ta bort igen, annars är botskyddet kvar avstängt
kubectl set env deployment/booking-api -n ticketing RATE_LIMIT_ALLOWLISTED_IPS-
```

## Lasttest: förutfärdade Auth0-tokens (Fas 6)

`tests/load/lib/config.js`s `AUTH_TOKENS` (docs/plan.md "Auth": "Lasttest
använder förutfärdade tokens") — checkout kräver en riktig Auth0-
inloggning, men VILKEN användare som betalar är inte det scenariot
mäter. En liten pool av riktiga access-tokens räcker, återanvänd över
alla 50 000 VU.

**Engångsförberedelse i Auth0 Dashboard** (samma SPA-app som
`AUTH0_WEB_CLIENT_ID`, docs/runbook.md "Nödvändiga GitHub
Actions-secrets"): **Applications → (appen) → Settings → Advanced
Settings → Grant Types** → slå på **Password** (avstängt som default för
en SPA-app — ROPG är annars avsett för M2M/legacy-klienter, men är den
enklaste vägen till ett RIKTIGT token utan att browserautomatisera hela
Universal Login för varje token som `booking-flow.spec.ts` gör). Kräver
även att tenantens **Authentication → Database → "Default Directory"**
är satt (Auth0-inställning, inte app-specifik) — annars svarar
`/oauth/token` med `unauthorized_client` oavsett Grant Types-inställningen.

**Slå AV Password-grantet igen efter lasttestet** — det är en
PRODUKTIONS-app (samma `AUTH0_WEB_CLIENT_ID` som den riktiga
inloggningen), och ROPG skickar användarens lösenord direkt till din
egen klient istället för Auth0:s hostade sida. Lämna det inte på
permanent. En egen, separat Auth0-app bara för lasttestet vore renare
men är inte prioriterat.

**Hämta ett token** (samma testkonto som e2e-sviten,
`AUTH0_TEST_USER_EMAIL`/`AUTH0_TEST_USER_PASSWORD`):

```sh
curl -s "https://$AUTH0_DOMAIN/oauth/token" \
  -H 'content-type: application/json' \
  -d "{\"grant_type\":\"password\",\"username\":\"$AUTH0_TEST_USER_EMAIL\",\"password\":\"$AUTH0_TEST_USER_PASSWORD\",\"client_id\":\"$AUTH0_WEB_CLIENT_ID\",\"audience\":\"$AUTH0_AUDIENCE\",\"scope\":\"openid profile email\"}" \
  | jq -r '.access_token'
```

Upprepa med ytterligare testkonton (skapa några fler i Auth0 för
poolens skull) om du vill undvika en enda delad identitet i
ordertabellen under rapportens granskning — en handfull räcker, inte
50 000. Klistra in dem kommaseparerat: `k6 run -e
AUTH_TOKENS=tok1,tok2,tok3 ...`. Tokens har en begränsad livstid
(Auth0-defaulten är timmar, inte dagar) — hämta färska strax innan en
körning, inte dagen före.

## Nödvändiga GitHub Actions-secrets (Fas 3)

`.github/workflows/deploy.yml` skapar `tickets-app-secrets` (namnrymd
`ticketing`) från fyra repo-secrets vid VARJE deploy — saknas någon av
dem misslyckas "Create/update app secrets"-steget:

- `AUTH0_DOMAIN`, `AUTH0_AUDIENCE` — från Auth0-tenanten (docs/plan.md "Auth").
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — från Stripes testläge (docs/plan.md "Betalning").
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET` — Fas 4,
  se "Backup-lagring: Cloudflare R2" nedan. Återanvänds i Fas 5 av
  `deploy-frontend`-jobbet för att ladda upp PWA:ns statiska filer till
  samma bucket, under prefixet `frontend/` (medvetet val — se docs/plan.md
  "Fas 5 — kända luckor": en egen bucket vore renare men är inte
  prioriterat).

**Fas 5 — en till secret:** `AUTH0_WEB_CLIENT_ID` — Client ID för en
**Single Page Application**-typ Auth0-"Application" (skild från Grafanas
och från ett ev. M2M-konto till scanner-appen senare), skapad så:

1. Auth0 dashboard → **Applications → Create Application → Single Page
   Application**, namn t.ex. "Tickets Web". SPA-klienter har inget
   client secret — bara Client ID behövs.
2. **Allowed Callback URLs / Allowed Logout URLs / Allowed Web Origins:**
   `https://tikknet.se` (lägg till `http://localhost:5173` också om du
   vill kunna logga in mot samma Auth0-app från lokal dev).
3. Kopiera **Client ID** → GitHub repo-secret `AUTH0_WEB_CLIENT_ID`.

Lägg till alla secrets under repots **Settings → Secrets and variables →
Actions → New repository secret**, med exakt dessa namn. `QUEUE_TOKEN_SECRET`,
`QR_TOKEN_SECRET` och payment-mocks webhook-hemlighet behöver INGEN
GitHub-secret — de genereras en gång av workflowen själv och lever bara
i klustret (`tickets-generated-secrets`), samma princip som
Postgres-lösenorden ovan.

## Auth0: e-post-claim på access token (Fas 3)

`services/booking-api/src/controllers/auth0-controller.ts` kräver `email` på
tokenet som kommer i `Authorization`-headern vid checkout. Auth0 lägger **inte**
in profil-claims som `email` i en access token som standard (det är en
ID-token-sak) — utan åtgärd misslyckas VARJE checkout med 401.

Lägg till en Auth0 **Action** (Auth0 Dashboard → Actions → Flows →
Login → lägg till en ny Action) som körs vid login och skriver claimen
namespaced (ett onamespacerat `email`-claim på en access token avvisas av
Auth0 självt):

```js
exports.onExecutePostLogin = async (event, api) => {
  if (event.user.email) {
    api.accessToken.setCustomClaim('https://tickets.app/email', event.user.email);
  }
};
```

Koden läser både det namespacade claimet och ett vanligt `email`-claim (det
sistnämnda bara för tester/lokala JWKS-stubbar) — ingen extra
`/userinfo`-rundtripp i checkout-kritisk väg.

## Byt till produktionscertifikat

`letsencrypt_use_staging` (Terraform) och `cert-manager.io/cluster-issuer`
(`infra/k8s/base/booking-api/ingress.yaml`) är **två oberoende reglage** som måste bytas
tillsammans, i den här ordningen — annars 526 på allt (docs/forsvar.md "Varför är
Cloudflares SSL-läge kopplat till letsencrypt_use_staging?"):

1. `infra/k8s/base/booking-api/ingress.yaml`: byt annotationen till `letsencrypt-production`.
2. Terraform: sätt `letsencrypt_use_staging = false` i `terraform.tfvars`, `terraform apply`
   (byter Cloudflares SSL-läge till `strict`).
3. Committa och merga — deploy-workflowen applicerar den nya annotationen.
4. Verifiera: `curl -I https://api.<domän>/health/live` ska ge `200`, och
   `openssl s_client -connect api.<domän>:443 -servername api.<domän> </dev/null 2>/dev/null |
   openssl x509 -noout -issuer` ska visa Let's Encrypt **utan** "(STAGING)".

Gör det **en gång**, mot slutet av Fas 1 eller i Fas 7, aldrig fram och tillbaka — Let's
Encrypt ger bara 5 identiska certifikat per vecka på produktions-CA:n.
