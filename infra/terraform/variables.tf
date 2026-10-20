# --- Hemligheter (aldrig default-värden, aldrig i tfvars som committas) ---

variable "hcloud_token" {
  description = "Hetzner Cloud API-token (Read & Write). Sätts via TF_VAR_hcloud_token."
  type        = string
  sensitive   = true
}

variable "cloudflare_api_token" {
  description = "Cloudflare API-token med Zone:DNS:Edit för domänens zon. Sätts via TF_VAR_cloudflare_api_token."
  type        = string
  sensitive   = true
}

variable "ssh_public_key" {
  description = "Din publika SSH-nyckel (innehåll, t.ex. $(cat ~/.ssh/id_ed25519.pub)), för åtkomst till noderna."
  type        = string
}

variable "admin_ipv4_cidr" {
  description = "Din egen IPv4-adress som CIDR (t.ex. 1.2.3.4/32), tillåts mot SSH (22). Kubernetes-API (6443) exponeras aldrig publikt — se firewall.tf."
  type        = string
}

variable "tailscale_node_authkey" {
  description = "Tailscale auth-nyckel som control-plane-noden ansluter till tailnet med. Till skillnad från CI:s nyckel (GitHub secret TS_AUTHKEY) ska den INTE vara ephemeral — noden ska stanna kvar i tailnet mellan omstarter. Reusable: på. Sätts via TF_VAR_tailscale_node_authkey."
  type        = string
  sensitive   = true
}

variable "tailscale_hostname" {
  description = "Namnet control-plane-noden får i tailnet (MagicDNS). Används i kubeconfig-serveradressen av både lokal kubectl och CI."
  type        = string
  default     = "tickets-cp-1"
}

# --- Domän ---

variable "domain_name" {
  description = "Din registrerade domän, t.ex. example.se. Zonen måste redan vara tillagd i Cloudflare."
  type        = string
}

# --- Hetzner-resurser ---

variable "hcloud_location" {
  description = "Hetzner-datacenter. fsn1 (Falkenstein) är billigast för europeiska användare."
  type        = string
  default     = "fsn1"
}

variable "server_type" {
  description = "Hetzner servertyp för klusternoderna under normal drift."
  type        = string
  default     = "cx22"
}

variable "node_count" {
  description = "Antal noder i klustret. 2 under utveckling (1 server + 1 agent), 3-4 under lasttest/demo. Se docs/plan.md \"Kostnadsstrategi\"."
  type        = number
  default     = 2

  validation {
    condition     = var.node_count >= 2
    error_message = "Minst 2 noder krävs: en k3s-server (control plane) och minst en agent."
  }
}

variable "k3s_version" {
  description = "k3s-kanal (t.ex. v1.31.4+k3s1). Pinnad version, inte 'stable' eller 'latest', för reproducerbara noder."
  type        = string
  default     = "v1.31.4+k3s1"
}

variable "enable_hcloud_csi" {
  description = "Installera Hetzner CSI-drivern (nätverksvolymer). Krävs för Postgres — se docs/forsvar.md \"Varför nätverksvolymer\"."
  type        = bool
  default     = true
}

# --- Cert-manager / Let's Encrypt ---

variable "letsencrypt_email" {
  description = "E-postadress för Let's Encrypt-kontot (utgångsvarningar m.m.)."
  type        = string
}

variable "letsencrypt_use_staging" {
  description = "true = LE staging-issuer (obegränsat antal försök, certifikat litas inte på av webbläsare). Håll på true tills kedjan är stabil — se docs/forsvar.md \"Varför DNS-01 i stället för HTTP-01\"."
  type        = bool
  default     = true
}

# --- Cloudflare IP-intervall (för brandväggsregeln: endast 443 från CF) ---
# Källa: https://www.cloudflare.com/ips/ — dessa ändras sällan men inte
# aldrig. Verifiera mot sidan innan skarp drift; defaultvärdena nedan är
# Cloudflares publicerade intervall vid skrivande stund.

variable "cloudflare_ipv4_ranges" {
  description = "Cloudflares publicerade IPv4-intervall. Källa: https://www.cloudflare.com/ips-v4"
  type        = list(string)
  default = [
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
  ]
}

variable "cloudflare_ipv6_ranges" {
  description = "Cloudflares publicerade IPv6-intervall. Källa: https://www.cloudflare.com/ips-v6"
  type        = list(string)
  default = [
    "2400:cb00::/32",
    "2606:4700::/32",
    "2803:f800::/32",
    "2405:b500::/32",
    "2405:8100::/32",
    "2a06:98c0::/29",
    "2c0f:f248::/32",
  ]
}
