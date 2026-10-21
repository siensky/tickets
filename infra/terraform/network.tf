# Privat nätverk för klustret — all nod-till-nod-trafik (k3s API, flannel
# overlay, Postgres-replikering senare) går här, inte över internet.
resource "hcloud_network" "cluster" {
  name     = "tickets-cluster"
  ip_range = "10.0.0.0/16"
}

resource "hcloud_network_subnet" "cluster" {
  network_id   = hcloud_network.cluster.id
  type         = "cloud"
  network_zone = "eu-central"
  ip_range     = "10.0.1.0/24"
}
