# Hämtar kubeconfig från control-plane-noden via SSH (port 22, publikt —
# oförändrat av Tailscale-bytet) och skriver den lokalt, med 127.0.0.1
# ersatt av nodens Tailscale-hostname. Både lokal kubectl och CI når
# alltså API-servern via samma adress, över Tailscale — 6443 är aldrig
# öppen i den publika brandväggen (firewall.tf).
#
# VIKTIGT: din egen maskin måste vara ansluten till SAMMA tailnet innan
# den här resursen (och allt som kommer efter — helm/kubernetes-
# providers) kan nå klustret. SSH-hämtningen ovan fungerar utan det
# (den går över publik IP), men "terraform apply" som helhet gör det
# inte. Se README.md i den här katalogen.
#
# Första "terraform apply" på ett helt nytt kluster kan behöva köras två
# gånger: providers (helm/kubernetes) läser in config_path innan
# resursgrafen exekveras, så filen måste redan finnas.
resource "null_resource" "fetch_kubeconfig" {
  depends_on = [hcloud_server.control_plane]

  triggers = {
    control_plane_id = hcloud_server.control_plane.id
  }

  provisioner "local-exec" {
    command = <<-EOT
      set -e
      for i in $(seq 1 30); do
        ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 \
          root@${hcloud_server.control_plane.ipv4_address} \
          'test -f /etc/rancher/k3s/k3s.yaml' && break
        sleep 10
      done
      ssh -o StrictHostKeyChecking=accept-new \
        root@${hcloud_server.control_plane.ipv4_address} \
        'cat /etc/rancher/k3s/k3s.yaml' \
        | sed 's/127.0.0.1/${var.tailscale_hostname}/' \
        > ${path.module}/.kube-config-raw
    EOT
  }
}

resource "local_sensitive_file" "kubeconfig" {
  depends_on = [null_resource.fetch_kubeconfig]

  filename        = "${path.module}/.kube/config"
  content         = fileexists("${path.module}/.kube-config-raw") ? file("${path.module}/.kube-config-raw") : ""
  file_permission = "0600"
}
