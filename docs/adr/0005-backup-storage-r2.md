# ADR-0005: Cloudflare R2 för databas-backuper, inte Backblaze B2

**Status:** Accepted
**Datum:** 2026-10-22

## Kontext

`docs/plan.md` "Infrastruktur" lämnade valet öppet: "Cloudflare R2 eller Backblaze
B2 (backups — S3-kompatibla ...)". Fas 4 bygger den nattliga `pg_dump`-CronJobben
(`infra/k8s/base/backup/cronjob.yaml`) och måste välja en av dem.

## Beslut

**Cloudflare R2.** Terraform har redan en Cloudflare-provider och ett konto i bruk
(DNS, Cache Rules, SSL-läge) — R2 kräver inget nytt konto, bara en ny, smalt scopad
API-token (samma princip som `docs/adr/0004-split-cloudflare-tokens.md`: en egen
token, `Object Read & Write` på exakt den bucketen, aldrig återanvänd för DNS/cache).
Backblaze B2 hade krävt ett helt nytt konto och leverantör för en enda uppgift.

Själva bucketen skapas **manuellt** i Cloudflare-dashboarden, inte av Terraform —
R2-krediterna som faktiskt ligger i klustret (en `rclone`-container i en CronJob) ska
inte dela token med Terraforms egen, bredare Cloudflare-åtkomst. Se
`docs/runbook.md` "Backup-lagring: Cloudflare R2" för de manuella stegen.

## Alternativ som övervägdes

- **Backblaze B2** — S3-kompatibelt på samma sätt, men ett extra konto/leverantör att
  sätta upp och hemlighetshantera för en enskild uppgift (nattlig dump-uppladdning).
  Inget i uppgiften kräver B2 specifikt.
- **Terraform-hanterad R2-bucket** (`cloudflare_r2_bucket`-resurs) — avvisat: hade
  krävt att bredda Terraforms befintliga `cloudflare_api_token` med R2-rättigheter,
  exakt den sammanblandning av behörigheter ADR-0004 avsiktligt löste upp.

## Konsekvenser

En extra, manuell engångsuppgift (skapa bucket + token i dashboarden) i stället för
`terraform apply`. I utbyte: R2-krediterna i klustret kan bara skriva/läsa en enda
bucket, och Terraforms egna Cloudflare-token rör aldrig backup-lagringen.
