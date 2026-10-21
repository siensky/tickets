provider "hcloud" {
  token = var.hcloud_token
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# helm/kubernetes pekar på en statisk sökväg som null_resource.fetch_kubeconfig
# (kubeconfig.tf) skriver direkt till efter att k3s-servern är uppe.
# Första "terraform apply" på ett helt nytt kluster kan behöva köras två
# gånger: filen finns inte förrän null_resource har kört, och providers
# läses in innan resursgrafen exekveras. Se infra/terraform/README.md.
provider "helm" {
  kubernetes {
    config_path = "${path.module}/.kube/config"
  }
}

provider "kubernetes" {
  config_path = "${path.module}/.kube/config"
}
