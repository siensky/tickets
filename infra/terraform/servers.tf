resource "random_password" "k3s_token" {
  length  = 48
  special = false
}

resource "hcloud_ssh_key" "admin" {
  name       = "tickets-admin"
  public_key = var.ssh_public_key
}

# Control-plane-noden får en fast privat IP så agent-noderna kan peka på
# den utan en beroendecykel i resursgrafen.
locals {
  control_plane_private_ip = "10.0.1.10"

  # Rensar bort \r och \n som kan smyga sig in vid kopiering från
  # webbgränssnitt (t.ex. Tailscales admin console) — osynliga i
  # terminalen och i verktyg som "wc -l" (som bara räknar \n), men
  # bryter YAML-strukturen i cloud-init eftersom YAML-specen räknar
  # både \r och \n som radbrytning i en block-literal. Se
  # docs/forsvar.md "Varför saneras tailscale_node_authkey i Terraform?".
  tailscale_node_authkey_clean = replace(
    replace(trimspace(var.tailscale_node_authkey), "\r", ""),
    "\n", ""
  )
}

resource "hcloud_server" "control_plane" {
  name         = "tickets-cp-1"
  server_type  = var.server_type
  image        = "ubuntu-24.04"
  location     = var.hcloud_location
  ssh_keys     = [hcloud_ssh_key.admin.id]
  firewall_ids = [hcloud_firewall.cluster.id]

  network {
    network_id = hcloud_network.cluster.id
    ip         = local.control_plane_private_ip
  }

  user_data = templatefile("${path.module}/cloud-init/k3s-server.yaml.tftpl", {
    k3s_token          = random_password.k3s_token.result
    k3s_version        = var.k3s_version
    private_ip         = local.control_plane_private_ip
    tailscale_authkey  = local.tailscale_node_authkey_clean
    tailscale_hostname = var.tailscale_hostname
  })

  depends_on = [hcloud_network_subnet.cluster]
}

resource "hcloud_server" "workers" {
  count        = var.node_count - 1
  name         = "tickets-worker-${count.index + 1}"
  server_type  = var.server_type
  image        = "ubuntu-24.04"
  location     = var.hcloud_location
  ssh_keys     = [hcloud_ssh_key.admin.id]
  firewall_ids = [hcloud_firewall.cluster.id]

  network {
    network_id = hcloud_network.cluster.id
    ip         = "10.0.1.${20 + count.index}"
  }

  user_data = templatefile("${path.module}/cloud-init/k3s-agent.yaml.tftpl", {
    k3s_token         = random_password.k3s_token.result
    k3s_version       = var.k3s_version
    private_ip        = "10.0.1.${20 + count.index}"
    server_private_ip = local.control_plane_private_ip
  })

  depends_on = [hcloud_server.control_plane]
}

# Lasttest-/demonoder — en SEPARAT resurs med en EGEN servertyp
# (var.demo_server_type, t.ex. CPX32), inte en höjning av node_count.
# Skalade man i stället node_count skulle Terraform storleksändra
# SAMTLIGA noder (server_type gäller alla), inklusive control-plane —
# en omstart av klustrets hjärna mitt i demoförberedelserna. Se
# docs/plan.md "Lasttest" och docs/forsvar.md "Varför en egen resurs för
# demonoder, inte bara fler worker_count?".
#
# IP-intervallet (10.0.1.30+) kolliderar inte med hcloud_server.workers
# (10.0.1.20 + index), som i praktiken aldrig blir fler än ett fåtal.
resource "hcloud_server" "demo_workers" {
  count        = var.demo_node_count
  name         = "tickets-demo-worker-${count.index + 1}"
  server_type  = var.demo_server_type
  image        = "ubuntu-24.04"
  location     = var.hcloud_location
  ssh_keys     = [hcloud_ssh_key.admin.id]
  firewall_ids = [hcloud_firewall.cluster.id]

  network {
    network_id = hcloud_network.cluster.id
    ip         = "10.0.1.${30 + count.index}"
  }

  user_data = templatefile("${path.module}/cloud-init/k3s-agent.yaml.tftpl", {
    k3s_token         = random_password.k3s_token.result
    k3s_version       = var.k3s_version
    private_ip        = "10.0.1.${30 + count.index}"
    server_private_ip = local.control_plane_private_ip
  })

  depends_on = [hcloud_server.control_plane]
}
