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

  # ICMP för felsökning (ping), bara från egen IP.
  rule {
    direction  = "in"
    protocol   = "icmp"
    source_ips = [var.admin_ipv4_cidr]
  }
}
