# ADR-0004: Två Cloudflare-tokens, olika scope

**Status:** Accepted
**Datum:** 2026-10-21

## Kontext

Terraform behövde höjda Cloudflare-rättigheter (Zone Settings:Edit, Cache Rules:Edit, utöver
DNS:Edit) utöver vad `README.md` ursprungligen dokumenterade. Samma, nu bredare, token
användes även för cert-managers DNS-01-secret inne i klustret — en podd fick därmed rätt att
ändra zonens SSL-läge och cache-regler, långt mer än ACME-utmaningen kräver.

## Beslut

Två separata tokens: `cloudflare_api_token` (bred, Terraform-only) och `cloudflare_dns_token`
(endast Zone:DNS:Edit, ENDAST i klustrets secret). Samma princip som de två
Tailscale-nycklarna (ADR-0001) — rätt mängd access för vad som faktiskt konsumerar den.

## Alternativ som övervägdes

- **En gemensam, bred token** (ursprungsläget) — avvisat efter att ha identifierat att det
  gör en komprometterad podd till en risk för hela zonens konfiguration, inte bara DNS.
- **Scopa ner Terraforms egen token igen** — inte möjligt: `cloudflare_zone_setting` och
  `cloudflare_ruleset` kräver de bredare rättigheterna för att fungera alls.

## Konsekvenser

En extra hemlighet att hantera (`TF_VAR_cloudflare_dns_token`), dokumenterad i
`infra/terraform/README.md`. I utbyte: den token som faktiskt ligger i klustret — den som en
komprometterad podd skulle kunna läsa — kan bara ändra DNS-poster, inget annat.
