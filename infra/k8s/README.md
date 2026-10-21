# infra/k8s

Kustomize-manifest: `base/` per tjänst, en `production`-overlay (den enda miljö CI faktiskt
deployar till — se `overlays/production/kustomization.yaml`). Se
[docs/plan.md](../../docs/plan.md) "Kubernetes". Byggs i **Fas 1** (walking skeleton) och
utökas genom hela projektet.

En `staging`-overlay fanns tidigare som en exakt kopia av `base/` — samma namnrymder, samma
`api.<domän>`-host, samma resursnamn, utan en enda differentierande patch. Den gjorde ingenting
(`kustomize` renderar bara text), men applicerad av misstag mot ett riktigt kluster hade den
skrivit över produktionen den skulle skilja sig från. Borttagen tills en riktig
stagingmiljö — egen namnrymd, eget värdnamn, egna secrets — faktiskt planeras. Se
`docs/forsvar.md` "Varför togs staging-overlayn bort?".
