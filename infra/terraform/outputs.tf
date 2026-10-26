output "control_plane_ipv4" {
  description = "Publik IPv4 för control-plane-noden — använd för SSH och felsökning."
  value       = hcloud_server.control_plane.ipv4_address
}

output "worker_ipv4s" {
  description = "Publika IPv4-adresser för worker-noderna."
  value       = [for s in hcloud_server.workers : s.ipv4_address]
}

output "demo_worker_ipv4s" {
  description = "Publika IPv4-adresser för demo-/lasttestnoderna (demo_node_count). Tom lista i vardagen."
  value       = [for s in hcloud_server.demo_workers : s.ipv4_address]
}

output "all_node_ipv4s" {
  description = "Samtliga noders publika IPv4 — det som DNS-posterna för api.<domän> pekar på."
  value       = values(local.node_ipv4_by_name)
}

output "kubeconfig_path" {
  description = "Lokal sökväg till den hämtade kubeconfig-filen. export KUBECONFIG=<detta värde>."
  value       = "${path.module}/.kube/config"
}

output "api_fqdn" {
  description = "Backendens fullständiga domännamn."
  value       = "api.${var.domain_name}"
}

output "loadgen_ipv4s" {
  description = "Publika IPv4-adresser för lastgenerator-VM:erna (loadgen_node_count). Tom lista i vardagen — SSH:a hit för att köra k6."
  value       = [for s in hcloud_server.loadgen : s.ipv4_address]
}

output "loadtest_fqdn" {
  description = "Direkt-mot-ingress-värdnamnet huvudkörningen ska gå mot (docs/plan.md \"Lasttest\") — icke-proxat, kräver att loadgen_node_count > 0:s IP:er är allowlistade i firewall.tf innan DNS-propageringen hunnit klart."
  value       = "loadtest.${var.domain_name}"
}
