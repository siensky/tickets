# Runbook — vad vi gör när något går fel

Fylls i under Fas 4 (backup/restore-övningen) och Fas 7. Ska svara på den
muntliga frågan "Driften: backups, och vad ni gör när något går fel."

## Återställning av databas (att fylla i i Fas 4)

## Vanliga larm och vad de betyder (att fylla i i Fas 4)

## Shard nere (att fylla i i Fas 2/6)

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
