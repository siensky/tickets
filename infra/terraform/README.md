# infra/terraform

Hetzner-servrar, brandvägg, privat nätverk, Cloudflare DNS, objektlagring,
samt klusterkomponenter som sällan ändras (ingress-nginx, cert-manager,
KEDA, kube-prometheus-stack). Se [docs/plan.md](../../docs/plan.md)
"Terraform". Byggs i **Fas 1**.

State är en lokal statefil och är `.gitignore`:ad (docs/forsvar.md "Varför
får Terraforms statefil aldrig committas?") — den innehåller hemligheter i
klartext. Säkerhetskopiera den manuellt utanför repot.
