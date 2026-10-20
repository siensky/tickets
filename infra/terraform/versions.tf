# Terraform äger: Hetzner-servrar, brandvägg, privat nätverk, Hetzner CSI,
# Cloudflare DNS + Cache Rule + SSL-läge, samt klusterkomponenter som sällan
# ändras (ingress-nginx, cert-manager). Se docs/plan.md "Terraform".
terraform {
  required_version = ">= 1.9"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.48"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.16"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.33"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.12"
    }
  }

  # Lokal statefil, medvetet. Innehåller hemligheter i klartext och är
  # .gitignore:ad — se docs/forsvar.md "Varför får Terraforms statefil
  # aldrig committas?". Säkerhetskopieras manuellt utanför repot.
  backend "local" {
    path = "terraform.tfstate"
  }
}
