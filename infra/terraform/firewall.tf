# Docs/plan.md "Säkerhet/Infrastruktur": "Endast port 443 öppen, och bara
# från Cloudflares IP-intervall. SSH (22) och Kubernetes-API (6443) låsta
# till egen IP."
#
# 6443 öppnas INTE här alls, inte ens mot admin_ipv4_cidr eller ett
# Tailscale-CIDR — Tailscale-trafik går genom en krypterad WireGuard-tunnel
# som Hetzners brandvägg (filtrerar på det publika gränssnittet) aldrig
# ser innehållet i. Att öppna 6443 mot ett "Tailscale-intervall" här hade
# alltså inte gjort något alls, och dessutom varit fel: all åtkomst till
# 6443 — både utvecklarens egen kubectl och CI — går via Tailscale, och
# control-plane-noden går med i samma tailnet (cloud-init). Se
# docs/forsvar.md "Varför öppnas 6443 aldrig i den publika brandväggen?".
resource "hcloud_firewall" "cluster" {
  name = "tickets-cluster"

  # HTTPS — endast från Cloudflare, aldrig direkt mot origin.
  dynamic "rule" {
    for_each = var.cloudflare_ipv4_ranges
    content {
      direction  = "in"
      protocol   = "tcp"
      port       = "443"
      source_ips = [rule.value]
    }
  }
  dynamic "rule" {
    for_each = var.cloudflare_ipv6_ranges
    content {
      direction  = "in"
      protocol   = "tcp"
      port       = "443"
      source_ips = [rule.value]
    }
  }

  # SSH — bara utvecklarens egen IP. Används av Terraform för att hämta
  # kubeconfig (kubeconfig.tf) och för direkt nodfelsökning.
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = [var.admin_ipv4_cidr]
  }

  # docs/plan.md "Lasttest": "Huvudkörningen går mot ett separat
  # värdnamn direkt mot ingress ... med brandväggen öppnad för
  # generatorernas IP:n" — annars mäts Cloudflares nät, inte vårt eget
  # system, och ett separat, icke-proxat DNS-namn (dns.tf) vore ändå
  # blockerat här utan den här regeln. Lastgeneratorernas EGNA, kända
  # IP:er (hcloud_server.loadgen) — aldrig en header en klient kan
  # förfalska, till skillnad från CF-Connecting-IP (docs/plan.md
  # "Botskydd"). Tom lista (loadgen_node_count = 0) i vardagen.
  dynamic "rule" {
    for_each = [for s in hcloud_server.loadgen : "${s.ipv4_address}/32"]
    content {
      direction  = "in"
      protocol   = "tcp"
      port       = "443"
      source_ips = [rule.value]
    }
  }

  # ICMP för felsökning (ping), bara från egen IP.
  rule {
    direction  = "in"
    protocol   = "icmp"
    source_ips = [var.admin_ipv4_cidr]
  }
}

# Lastgeneratorerna får sin EGEN, separat brandvägg i stället för
# hcloud_firewall.cluster ovan — annars uppstår en beroendecykel:
# cluster-brandväggen refererar loadgen-servrarnas IP:er (regeln ovan),
# och om loadgen-servrarna i sin tur hade pekat tillbaka på SAMMA
# brandväggsresurs för sin egen firewall_ids hade Terraform sett
# cluster → loadgen → cluster och vägrat planera. Samma admin-only-regler
# som cluster-brandväggen, bara i en egen resurs.
resource "hcloud_firewall" "loadgen" {
  name = "tickets-loadgen"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = [var.admin_ipv4_cidr]
  }

  rule {
    direction  = "in"
    protocol   = "icmp"
    source_ips = [var.admin_ipv4_cidr]
  }
}
