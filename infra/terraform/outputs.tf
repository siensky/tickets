output "control_plane_ipv4" {
  description = "Publik IPv4 för control-plane-noden — använd för SSH och felsökning."
  value       = hcloud_server.control_plane.ipv4_address
}

output "worker_ipv4s" {
  description = "Publika IPv4-adresser för worker-noderna."
  value       = [for s in hcloud_server.workers : s.ipv4_address]
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
