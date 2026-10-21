# ADR-0002: DNS-01 i stället för HTTP-01, och Let's Encrypt staging först

**Status:** Accepted
**Datum:** 2026-10-20

## Kontext

Origin behöver ett giltigt TLS-certifikat bakom Cloudflare i Full (strict)-läge. HTTP-01-
utmaningen kräver port 80 nåbar från Let's Encrypt, vilket krockar med att vi bara öppnar 443
mot Cloudflares egna IP-intervall (`docs/forsvar.md`).

## Beslut

cert-manager med en DNS-01-solver mot Cloudflare (en separat, smalt scopad token — se
ADR-0004). Let's Encrypt **staging**-issuer används tills kedjan är verifierat stabil, prod-
issuer kopplas in genom en enda, dokumenterad manuell ändring (`docs/runbook.md` "Byt till
produktionscertifikat").

## Alternativ som övervägdes

- **HTTP-01** — avvisat: kräver port 80 öppen mot hela internet (inte bara Let's Encrypts
  egna IP:n, eftersom de inte publicerar ett stabilt intervall), rakt emot brandväggsdesignen.
- **Självsignerat cert + Cloudflare Full (inte strict)** — avvisat: Full validerar inte
  origin-certet alls, vilket är ett sämre säkerhetsläge än strict utan att vinna något i
  utbyte (DNS-01 kostar inget extra jämfört med HTTP-01 när man ändå har en Cloudflare-token).
- **Köra produktions-CA direkt, utan staging** — avvisat: Let's Encrypt ger 5 identiska
  certifikat per vecka på produktions-CA:n. Upprepade `terraform apply`/`destroy` under
  utveckling hade bränt den kvoten på en dag.

## Konsekvenser

Cloudflares SSL-läge måste vara kopplat till vilken issuer som faktiskt är aktiv (se
`docs/forsvar.md` "Varför är Cloudflares SSL-läge kopplat till letsencrypt_use_staging?") —
strict + ett icke-betrott staging-cert ger `526` på allt. En extra Cloudflare-token med
snävare rättigheter krävs (DNS-01-secreten i klustret, se ADR-0004).
