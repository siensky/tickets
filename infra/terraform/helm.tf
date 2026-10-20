# Terraform äger klusterkomponenter som sällan ändras (ingress-nginx,
# cert-manager) — se docs/plan.md "Terraform". KEDA och
# kube-prometheus-stack installeras här senare (Fas 3 respektive Fas 4),
# inte nu.

resource "kubernetes_namespace" "ingress_nginx" {
  depends_on = [local_sensitive_file.kubeconfig]
  metadata {
    name = "ingress-nginx"
  }
}

resource "kubernetes_namespace" "cert_manager" {
  depends_on = [local_sensitive_file.kubeconfig]
  metadata {
    name = "cert-manager"
  }
}

# Delas av CCM och CSI-drivern — båda letar efter en secret som heter
# "hcloud" med nyckeln "token", som är respektive projekts egen
# standardkonvention.
resource "kubernetes_secret" "hcloud" {
  depends_on = [local_sensitive_file.kubeconfig]
  metadata {
    name      = "hcloud"
    namespace = "kube-system"
  }
  data = {
    token = var.hcloud_token
  }
}

# Krävs av CSI-drivern för att veta vilken Hetzner-server en nod är — se
# docs/forsvar.md "Varför nätverksvolymer". networking.enabled = false:
# poddnätverket sköts av k3s egen flannel, inte Hetzners routningstabeller.
resource "helm_release" "hcloud_ccm" {
  name       = "hcloud-cloud-controller-manager"
  repository = "https://charts.hetzner.cloud"
  chart      = "hcloud-cloud-controller-manager"
  version    = "1.39.0"
  namespace  = "kube-system"

  depends_on = [kubernetes_secret.hcloud]

  set {
    name  = "networking.enabled"
    value = "false"
  }
}

resource "helm_release" "hcloud_csi" {
  count      = var.enable_hcloud_csi ? 1 : 0
  name       = "hcloud-csi"
  repository = "https://charts.hetzner.cloud"
  chart      = "hcloud-csi"
  version    = "2.24.0"
  namespace  = "kube-system"

  # CSI-drivern behöver CCM:s providerID på noderna för att fungera
  # korrekt, inte bara secreten.
  depends_on = [helm_release.hcloud_ccm]
}

# docs/plan.md "Trafikväg": ingress-nginx som DaemonSet på varje nod,
# hostPort 443 — Cloudflare pekar direkt på nodernas publika IP:er,
# ingen Hetzner-managed load balancer. type: ClusterIP på Service:en
# eftersom vi inte vill ha en LoadBalancer-Service (k3s servicelb är
# avstängt, och vi har ingen Hetzner LB).
resource "helm_release" "ingress_nginx" {
  name       = "ingress-nginx"
  repository = "https://kubernetes.github.io/ingress-nginx"
  chart      = "ingress-nginx"
  version    = "4.15.1"
  namespace  = kubernetes_namespace.ingress_nginx.metadata[0].name

  depends_on = [helm_release.hcloud_ccm]

  values = [yamlencode({
    controller = {
      kind = "DaemonSet"
      hostPort = {
        enabled = true
        ports = {
          http  = 80
          https = 443
        }
      }
      service = {
        type = "ClusterIP"
      }
      # docs/plan.md "Botskydd": CF-Connecting-IP litas på endast från
      # Cloudflares intervall — docs/forsvar.md "Varför måste rate
      # limitern läsa CF-Connecting-IP...".
      config = {
        use-forwarded-headers = "true"
        forwarded-for-header  = "CF-Connecting-IP"
        proxy-real-ip-cidr    = join(",", concat(var.cloudflare_ipv4_ranges, var.cloudflare_ipv6_ranges))
        # docs/plan.md "Realtid": heartbeat var ~30:e sekund — ge marginal
        # utöver det så idle WS-anslutningar inte kapas i onödan.
        proxy-read-timeout    = "120"
        proxy-send-timeout    = "120"
        worker-connections    = "10000"
        max-worker-open-files = "20000"
      }
      resources = {
        requests = {
          cpu    = "100m"
          memory = "128Mi"
        }
        limits = {
          cpu    = "500m"
          memory = "256Mi"
        }
      }
    }
  })]
}

resource "helm_release" "cert_manager" {
  name       = "cert-manager"
  repository = "https://charts.jetstack.io"
  chart      = "cert-manager"
  version    = "v1.21.2"
  namespace  = kubernetes_namespace.cert_manager.metadata[0].name

  depends_on = [kubernetes_namespace.cert_manager]

  values = [yamlencode({
    crds = {
      enabled = true
    }
  })]
}

# Cloudflare API-token för DNS-01, som en secret i cert-manager-namnrymden
# — cert-manager letar efter den när ClusterIssuer refererar den.
resource "kubernetes_secret" "cloudflare_api_token" {
  depends_on = [kubernetes_namespace.cert_manager]
  metadata {
    name      = "cloudflare-api-token"
    namespace = "cert-manager"
  }
  data = {
    api-token = var.cloudflare_api_token
  }
}
