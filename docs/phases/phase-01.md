# Fas 1 — Walking skeleton

**Status:** klar och mergad. Inget eget avsnitt i `phase-status.md` (filen började skrivas efter Fas 3).

## Mål

**G: automatisk deploy**

## Omfattning

Planerat datum: 20–22/10.

**Walking skeleton.** Terraform: 2 noder, brandvägg, privat nät, **Hetzner CSI**. k3s, ingress-nginx, **cert-manager med DNS-01 + LE staging**, CF **Full (strict)** + **Cache Rule** + **CF-Connecting-IP-konfiguration**. Actions: lint → typecheck → test → image → **migrations-Job** → `kubectl apply` → `rollout status`. **Mät cache hit ratio.**

## Beroenden

Fas 0 klar.

## Berör

[`specification.md`](../specification.md): "Hetzner, Terraform och k3s", "Trafikväg", "Deploy".

## Implementationssteg

Fasen planerades som raden i fastabellen ("Omfattning" ovan), utan numrerade steg.

## Acceptanskriterier

Inte formulerat som egna kriterier när fasen byggdes. Målet ovan och kraven i
[`specification.md`](../specification.md) "Kraven och var de uppfylls" gäller.
