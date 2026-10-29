# Terraform äger klusterkomponenter som sällan ändras (ingress-nginx,
# cert-manager, KEDA) — se docs/plan.md "Terraform".
# kube-prometheus-stack installeras här senare (Fas 4), inte nu.

resource "kubernetes_namespace" "ingress_nginx" {
  depends_on = [null_resource.fetch_kubeconfig]
  metadata {
    name = "ingress-nginx"
  }
}

resource "kubernetes_namespace" "keda" {
  depends_on = [null_resource.fetch_kubeconfig]
  metadata {
    name = "keda"
  }
}

# docs/plan.md "Tjänster": notification-worker (1–10 repliker) skalar på
# RabbitMQ-ködjup. Operatören installeras nu, i Fas 3, tillsammans med
# resten av notification-worker — den faktiska `ScaledObject`-resursen
# som pekar på den här operatören (min/max-repliker, tröskeln 100
# meddelanden/podd) läggs till i Fas 6 (docs/plan.md "Fasplan"), när HPA
# och lastgeneratorerna byggs och mäts tillsammans.
resource "helm_release" "keda" {
  name       = "keda"
  repository = "https://kedacore.github.io/charts"
  chart      = "keda"
  version    = "2.20.2"
  namespace  = kubernetes_namespace.keda.metadata[0].name

  depends_on = [kubernetes_namespace.keda]
}

resource "kubernetes_namespace" "cert_manager" {
  depends_on = [null_resource.fetch_kubeconfig]
  metadata {
    name = "cert-manager"
  }
}

# Delas av CCM och CSI-drivern — båda letar efter en secret som heter
# "hcloud" med nyckeln "token", som är respektive projekts egen
# standardkonvention.
resource "kubernetes_secret" "hcloud" {
  depends_on = [null_resource.fetch_kubeconfig]
  metadata {
    name      = "hcloud"
    namespace = "kube-system"
  }
  data = {
    token = var.hcloud_token
  }
}

# Hetzners CCM: sätter nodlabels (region, instanstyp), städar bort Node-objekt
# för borttagna servrar och ger LoadBalancer-stöd. Ligger INTE på den kritiska
# vägen för volymer — se docs/forsvar.md "Varför sätter cloud-init providerID
# själv?" för smoketestet som visade det.
resource "helm_release" "hcloud_ccm" {
  name       = "hcloud-cloud-controller-manager"
  repository = "https://charts.hetzner.cloud"
  chart      = "hcloud-cloud-controller-manager"
  version    = "1.39.0"
  namespace  = "kube-system"

  depends_on = [kubernetes_secret.hcloud]

  # networking.enabled = false: chartens networking-läge lägger till
  # --allocate-node-cidrs och --cluster-cidr på CCM, men pod-CIDR:er delas
  # redan ut av k3s egen controller-manager. Två allokerare för samma sak
  # är en konflikt vi inte vill ha.
  set {
    name  = "networking.enabled"
    value = "false"
  }
  # HCLOUD_NETWORK måste ändå sättas, annars rapporterar CCM bara nodernas
  # PUBLIKA adresser och avvisar vår privata node-ip i evig loop:
  # "failed to get node address from cloud provider that matches ip: 10.0.1.x".
  # Charten renderar bara HCLOUD_NETWORK själv när networking.enabled = true,
  # så här sätts den direkt — ingen dubblett uppstår.
  set {
    name  = "env.HCLOUD_NETWORK.value"
    value = hcloud_network.cluster.name
    type  = "string"
  }
  # Flannel äger routingen mellan noderna (flannel-iface på det privata
  # interfacet). CCM:s route-controller stängs därför av explicit — annars
  # skriver två komponenter routes för samma pod-CIDR:er.
  #
  # type = "string" är nödvändigt: utan den tolkar Helm "false" som en
  # boolean, och Kubernetes avvisar manifestet med "cannot unmarshal bool
  # into Go struct field EnvVar...value of type string".
  set {
    name  = "env.HCLOUD_NETWORK_ROUTES_ENABLED.value"
    value = "false"
    type  = "string"
  }
}

resource "helm_release" "hcloud_csi" {
  count      = var.enable_hcloud_csi ? 1 : 0
  name       = "hcloud-csi"
  repository = "https://charts.hetzner.cloud"
  chart      = "hcloud-csi"
  version    = "2.24.0"
  namespace  = "kube-system"

  # CSI-drivern läser Hetzners server-ID från metadata-tjänsten på varje
  # nod, INTE från nodens providerID — verifierat med ett smoketest där
  # en volym provisionerades och kopplades med providerID satt till
  # k3s://<namn>. Beroendet på CCM finns alltså för ordningens skull
  # (secreten, nodlabels), inte för att volymhanteringen kräver det.
  # Se docs/forsvar.md "Varför nätverksvolymer".
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
      # docs/plan.md 7.4: nginx_ingress_controller_requests (ingress-5xx
      # och request rate i Grafana). Prometheus hittar ServiceMonitorn i
      # alla namnrymder (observability.tf).
      metrics = {
        enabled = true
        serviceMonitor = {
          enabled = true
        }
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
          cpu    = "200m"
          memory = "256Mi"
        }
        limits = {
          cpu    = "1000m"
          memory = "512Mi"
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
#
# var.cloudflare_dns_token, INTE var.cloudflare_api_token: den breda token
# som Terraform själv använder (SSL-läge, cache-regler, DNS) hör aldrig
# hemma i klustret — en podd som kan läsa den secreten skulle annars kunna
# göra allt det en angripare kan göra med Terraforms egna uppgifter. Se
# docs/forsvar.md "Varför två Cloudflare-tokens?".
resource "kubernetes_secret" "cloudflare_api_token" {
  depends_on = [kubernetes_namespace.cert_manager]
  metadata {
    name      = "cloudflare-api-token"
    namespace = "cert-manager"
  }
  data = {
    api-token = var.cloudflare_dns_token
  }
}
