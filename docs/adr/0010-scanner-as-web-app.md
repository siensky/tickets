# ADR-0010: Biljettscannern som webbapp i stället för Expo

**Status:** Accepted
**Datum:** 2026-10-30

## Kontext

Den ursprungliga planen var en Expo-app för personalen med OAuth2 client credentials (M2M) och
offline-kö. Scannern är ett extra steg efter VG-kraven och ska gå att bygga och deploya med samma
pipeline som resten.

## Beslut

En webbapp, `apps/scanner`, på `scan.<domän>`: Vite + React + TypeScript med samma tema som
webbappen. Personalen loggar in med vanlig Auth0-inloggning (SPA-app "Scanner") och rollen `staff` med
permissionen `scan:tickets`; QR-koden läses med `@zxing/browser` och bakre kameran. Kameran fungerar i
mobilwebbläsare över HTTPS. Bygget, uppladdningen till R2 och Workern följer samma mönster som
webbappen. `POST /scans` i booking-api kräver permissionen och verifierar den på servern.

## Alternativ som övervägdes

- **Expo-app med M2M** — kräver app store/EAS, en egen byggkedja och en M2M-token som måste cachas i
  appen; M2M-kvoten är dessutom begränsad.
- **Offline-kö** — avvisat: skanningen kräver nät, annars går dubbelskanning inte att avgöra.

## Konsekvenser

Ingen app store och ingen separat byggkedja. Ingen offline-skanning och ingen manuell inmatning
(biljettnummer visas inte för köparen). QR-koden är en HMAC som inte går att avkoda, så uppslaget görs på
`tickets.qr_token` per event; "fel event" går därför inte att skilja från "ogiltig" (båda `not_found`).
