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
#
# for_each nycklas på IP:n, INTE på nodnamn. Nodnamnen är stabila medan IP:na
# byts när en nod byggs om, och Hetzner återanvänder adresser: nycklas posten
# på namnet försöker Terraform UPPDATERA innehållet, och om två noder bytt
# adress med varandra kolliderar uppdateringen med den andra posten
# ("81058: An identical record already exists"). Med IP:n som nyckel ändras
# aldrig en posts innehåll — en ny adress blir en ny post och den gamla rivs.
resource "cloudflare_dns_record" "api" {
  for_each = toset(values(local.node_ipv4_by_name))

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
    { for s in hcloud_server.workers : s.name => s.ipv4_address },
    # Demonoderna kör ingress-nginx (DaemonSet) precis som alla andra
    # noder — utan en DNS-post för dem får de aldrig trafik från
    # Cloudflare, och hela poängen med att provisionera dem i förväg
    # (docs/plan.md "Nodnivå") går förlorad.
    { for s in hcloud_server.demo_workers : s.name => s.ipv4_address }
  )
}
