# ADR-0009: PostHog EU med reverse proxy på egen domän

**Status:** Accepted
**Datum:** 2026-10-30

## Kontext

Vi vill mäta bokningsflödet (tratt, kö-avhopp, utgångna reservationer) och testa en feature flag.
Analysen är inte betygsgrundande men ska vara korrekt och respektera användarens samtycke (GDPR).

## Beslut

**PostHog Cloud i EU-regionen.** Webbläsaren skickar händelser till `/ingest` på vår egen domän; den
befintliga apex-Workern (`frontend-proxy.js`) vidarebefordrar `/ingest/static/*` till
`eu-assets.i.posthog.com` och övriga `/ingest/*` till `eu.i.posthog.com`, och inga andra sökvägar.
Utan proxy blockerar adblockers en stor andel av händelserna. Kritiska konverteringshändelser
(`payment_succeeded`, `payment_late_refunded`) skickas från servern, så en stängd flik eller en
adblocker inte tappar dem. `distinct_id` är Auth0 `sub` på båda sidor (opakt, ingen PII), så tratten
går ihop. Händelsekatalogen i `shared/analytics` är den enda källan till namn och props.

Samtycke: cookielöst (minnesbaserat id) tills användaren godkänner i en banner; flaggor utvärderas bara
efter samtycke; `identify` görs bara efter samtycke. Session replay och autocapture är av, och
`before_send` tar bort Auth0:s `code`/`state` och söktexten ur URL:er.

## Alternativ som övervägdes

- **Egen analys i databasen** — mer kod att bygga och underhålla för något som inte betygsätts.
- **Google Analytics** — data lämnar EU, och det ger inte tratt och serverhändelser på samma sätt.
- **PostHog utan proxy** — enklare men blockeras ofta av adblockers.

## Konsekvenser

En extra tjänst att konfigurera manuellt (konto, projekt, flagga, nycklar som GitHub-secrets). Analytics
är no-op utan nyckel, så lokalt, i CI och i tester krävs ingenting. Under `loadtest-mode on` stängs
server-analytics av (`POSTHOG_ENABLED=false`) så k6-trafik inte fyller datan.
