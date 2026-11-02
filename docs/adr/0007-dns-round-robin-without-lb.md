# ADR-0007: DNS round-robin direkt mot noderna, ingen extern lastbalanserare

**Status:** Accepted
**Datum:** 2026-10-30

## Kontext

Trafiken ska fördelas över flera noder. En Hetzner Load Balancer är en extra betald resurs som ligger
utanför det gratislager projektet byggts runt (Cloudflare för DNS, CDN och TLS).

## Beslut

DNS round-robin fördelar trafiken mellan noderna: A-posterna pekar direkt mot nodernas publika
IP-adresser. ingress-nginx körs som DaemonSet på varje nod och ruttar på värdnamn vidare till
tjänsterna, och en Service lastbalanserar över minst två `booking-api`-poddar. Lastbalanseringen mellan
poddar finns alltså i klustret (ingress-nginx plus Service); det som saknas är en extern lastbalanserare
framför noderna. Det finns ingen hälsokontroll av origin-IP:erna, så en nod som är nere får fortfarande
sin andel av klienterna tills posten tas bort.

## Alternativ som övervägdes

- **Hetzner Load Balancer** — ger hälsokontroller men kostar och är ytterligare en resurs att hålla
  i Terraform. Avvisat för kostnaden och för ytterligare en resurs att underhålla; nämns som nästa steg.
- **Cloudflare Load Balancing** — betalfunktion, avvisad av samma skäl.

## Konsekvenser

Lärdom från lasttestet (`infra/LASTTEST-NOTES.md`): lasttestet går mot `loadtest.tikknet.se`, en
oproxad post med DNS round-robin direkt mot nod-IP:erna. När ingress-nginx på en nod startades om eller
fick slut på minne såg klienter `connection refused` mot just den nodens IP. Därför höjdes
ingress-nginx till 1000m/512Mi, och zero-downtime-beviset (`docs/evidence/zero-downtime.md`) mäter
bara en `booking-api`-rollout, som inte rör ingress-poddarna. Vid "döda shard-1 live" i demon tas en
pod bort, aldrig en hel nod, av samma skäl.
