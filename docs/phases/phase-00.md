# Fas 0 — Repo och tooling

**Status:** klar och mergad. Inget eget avsnitt i `phase-status.md` (filen började skrivas efter Fas 3).

## Mål

Inget eget mål i fastabellen. Kolumnen sa bara **Klar** (raden var överstruken som avklarad).

## Omfattning

Planerat datum: 19/10.

Repo, tooling, felhierarki, docker-compose

## Beroenden

Inga tidigare faser. Förutsättningarna som skulle ordnas parallellt står under "Implementationssteg".

## Berör

[`specification.md`](../specification.md): "Repo".

## Implementationssteg

Fasen planerades som raden i fastabellen ("Omfattning" ovan), utan numrerade steg.

### Att ordna parallellt med fas 1

Rubriken hette "Att ordna parallellt med fas 0" i en tidigare version av planen.

1. ~~Lärarens godkännande för soloprojekt~~ — **klart**
2. **Domän** — köp tidigt, DNS-propagering vill man inte vänta på i fas 1
3. **Konton** — Hetzner (kortverifiering kan ta en dag), Cloudflare (**API-token för
   DNS-01**), Auth0, Slack-webhook. Kolla GitHub Student Developer Pack först
4. **Auth0 M2M-kvot** — verifiera den innan scanner-fasen. Scannern måste **cacha sin
   token**, inte hämta en ny per skanning

## Acceptanskriterier

Inte formulerat som egna kriterier när fasen byggdes. Målet ovan och kraven i
[`specification.md`](../specification.md) "Kraven och var de uppfylls" gäller.
