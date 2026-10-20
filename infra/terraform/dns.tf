# Endast api.<domän> skapas i Fas 1 — det är vad Fas 1 faktiskt levererar
# (booking-api med health+metrics). cdn.<domän> och apex-domänen pekar mot
# resurser som inte finns förrän Fas 5 (PWA-deploy till R2/B2) och läggs
# till då, inte här.
data "cloudflare_zone" "this" {
  filter = {
    name = var.domain_name
  }
}

# En A-post per nod, alla proxade (orange cloud) — Cloudflare lastbalanserar
# och döljer origin-IP:erna. ingress-nginx (DaemonSet) svarar på alla.
resource "cloudflare_dns_record" "api" {
  for_each = local.node_ipv4_by_name

  zone_id = data.cloudflare_zone.this.zone_id
  name    = "api"
  type    = "A"
  content = each.value
  proxied = true
  ttl     = 1 # "Auto" när proxied = true
}

locals {
  node_ipv4_by_name = merge(
    { (hcloud_server.control_plane.name) = hcloud_server.control_plane.ipv4_address },
    { for s in hcloud_server.workers : s.name => s.ipv4_address }
  )
}
