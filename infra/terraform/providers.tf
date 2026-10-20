provider "hcloud" {
  token = var.hcloud_token
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# helm/kubernetes pekar på en kubeconfig som skrivs lokalt av
# null_resource.fetch_kubeconcfig (kubeconfig.tf) efter att k3s-servern är
# uppe. Första "terraform apply" på en helt ny klustret kan behöva köras
# två gånger: filen finns inte förrän null_resource har kört, och
# providers läses in innan resursgrafen exekveras. Se infra/terraform/README.md.
provider "helm" {
  kubernetes {
    config_path = local_sensitive_file.kubeconfig.filename
  }
}

provider "kubernetes" {
  config_path = local_sensitive_file.kubeconfig.filename
}
