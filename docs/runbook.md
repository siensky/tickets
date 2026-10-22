# Runbook — vad vi gör när något går fel

Fylls i under Fas 4 (backup/restore-övningen) och Fas 7. Ska svara på den
muntliga frågan "Driften: backups, och vad ni gör när något går fel."

## Återställning av databas (att fylla i i Fas 4)

## Vanliga larm och vad de betyder (att fylla i i Fas 4)

## Shard nere (att fylla i i Fas 2/6)

## Nödvändiga GitHub Actions-secrets (Fas 3)

`.github/workflows/deploy.yml` skapar `tickets-app-secrets` (namnrymd
`ticketing`) från fyra repo-secrets vid VARJE deploy — saknas någon av
dem misslyckas "Create/update app secrets"-steget:

- `AUTH0_DOMAIN`, `AUTH0_AUDIENCE` — från Auth0-tenanten (docs/plan.md "Auth").
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — från Stripes testläge (docs/plan.md "Betalning").

Lägg till dem under repots **Settings → Secrets and variables →
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
