# Fas 4 (docs/plan.md "Fasplan"): kube-prometheus-stack (Prometheus +
# Alertmanager + Grafana), Loki + Alloy. Terraform-owned like cert-manager/
# ingress-nginx/KEDA — "klusterkomponenter som sällan ändras" (docs/plan.md
# "Terraform"). ServiceMonitors/PrometheusRules/dashboards that reference
# app-level Services live in infra/k8s/base instead, applied by
# .github/workflows/deploy.yml like the rest of the application manifests —
# they change with the app, not with the cluster.
resource "kubernetes_namespace" "observability" {
  depends_on = [null_resource.fetch_kubeconfig]
  metadata {
    name = "observability"
  }
}

# Grafana's break-glass admin account. OAuth (below) is the real login path;
# this exists only so a lost Auth0 connection can't lock everyone out, and —
# docs/plan.md "Observability": "inget default-admin ligger i en committad
# values-fil" — the password lives only in Terraform state and this secret,
# generated once, never typed or committed anywhere.
resource "random_password" "grafana_admin" {
  length  = 32
  special = false
}

resource "kubernetes_secret" "grafana_admin" {
  depends_on = [kubernetes_namespace.observability]
  metadata {
    name      = "grafana-admin-credentials"
    namespace = kubernetes_namespace.observability.metadata[0].name
  }
  data = {
    admin-user     = "admin"
    admin-password = random_password.grafana_admin.result
  }
}

resource "kubernetes_secret" "grafana_oauth" {
  depends_on = [kubernetes_namespace.observability]
  metadata {
    name      = "grafana-oauth-credentials"
    namespace = kubernetes_namespace.observability.metadata[0].name
  }
  data = {
    client-id     = var.grafana_auth0_client_id
    client-secret = var.grafana_auth0_client_secret
  }
}

# Mounted as a file into Alertmanager (alertmanagerSpec.secrets below) so the
# webhook URL never appears in the Helm values themselves — api_url_file,
# not api_url.
resource "kubernetes_secret" "alertmanager_slack" {
  depends_on = [kubernetes_namespace.observability]
  metadata {
    name      = "alertmanager-slack-webhook"
    namespace = kubernetes_namespace.observability.metadata[0].name
  }
  data = {
    url = var.slack_webhook_url
  }
}

# docs/plan.md "Observability": kube-prometheus-stack installeras via
# Terraform; "Diskutrymme": retentionSize + dimensionerad PVC, annars fyller
# Prometheus en nods hela disk (40 GB) och kubelet evikterar poddar mitt i
# ett lasttest. 8GB stays comfortably under the 10Gi PVC below.
resource "helm_release" "kube_prometheus_stack" {
  name       = "kube-prometheus-stack"
  repository = "https://prometheus-community.github.io/helm-charts"
  chart      = "kube-prometheus-stack"
  version    = "92.11.0"
  namespace  = kubernetes_namespace.observability.metadata[0].name

  depends_on = [
    kubernetes_secret.grafana_admin,
    kubernetes_secret.grafana_oauth,
    kubernetes_secret.alertmanager_slack,
  ]

  values = [yamlencode({
    prometheus = {
      prometheusSpec = {
        retention     = "10d"
        retentionSize = "8GB"
        storageSpec = {
          volumeClaimTemplate = {
            spec = {
              storageClassName = "hcloud-volumes"
              accessModes      = ["ReadWriteOnce"]
              resources        = { requests = { storage = "10Gi" } }
            }
          }
        }
        # App-level ServiceMonitors/PodMonitors/PrometheusRules
        # (infra/k8s/base/monitoring) live in "ticketing"/"data", not in this
        # chart's own release — the chart's label-scoped selectors would
        # otherwise ignore them. Standard simplification for a
        # single-cluster, single-tenant setup.
        serviceMonitorSelectorNilUsesHelmValues = false
        podMonitorSelectorNilUsesHelmValues     = false
        ruleSelectorNilUsesHelmValues           = false
      }
    }

    alertmanager = {
      alertmanagerSpec = {
        secrets = [kubernetes_secret.alertmanager_slack.metadata[0].name]
      }
      config = {
        global = { resolve_timeout = "5m" }
        route = {
          group_by        = ["namespace", "alertname"]
          group_wait      = "30s"
          group_interval  = "5m"
          repeat_interval = "3h"
          receiver        = "slack"
        }
        receivers = [{
          name = "slack"
          slack_configs = [{
            channel       = "#tickets-alerts"
            send_resolved = true
            api_url_file  = "/etc/alertmanager/secrets/${kubernetes_secret.alertmanager_slack.metadata[0].name}/url"
          }]
        }]
      }
    }

    grafana = {
      admin = {
        existingSecret = kubernetes_secret.grafana_admin.metadata[0].name
        userKey        = "admin-user"
        passwordKey    = "admin-password" # gitleaks:allow -- key name only, actual value lives in kubernetes_secret.grafana_admin
      }
      ingress = {
        enabled          = true
        ingressClassName = "nginx"
        annotations = {
          "cert-manager.io/cluster-issuer" = "letsencrypt-staging"
        }
        hosts = ["grafana.${var.domain_name}"]
        tls = [{
          secretName = "grafana-tls"
          hosts      = ["grafana.${var.domain_name}"]
        }]
      }
      envValueFrom = {
        GF_AUTH_GENERIC_OAUTH_CLIENT_ID = {
          secretKeyRef = { name = kubernetes_secret.grafana_oauth.metadata[0].name, key = "client-id" }
        }
        GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET = {
          secretKeyRef = { name = kubernetes_secret.grafana_oauth.metadata[0].name, key = "client-secret" }
        }
      }
      "grafana.ini" = {
        server = {
          root_url = "https://grafana.${var.domain_name}"
        }
        auth = {
          # Login form stays on so the break-glass admin account above is
          # actually reachable — only anonymous access is disallowed
          # (docs/plan.md "Observability").
          disable_login_form = false
        }
        "auth.generic_oauth" = {
          enabled       = true
          name          = "Auth0"
          allow_sign_up = true
          scopes        = "openid profile email"
          auth_url      = "https://${var.grafana_auth0_domain}/authorize"
          token_url     = "https://${var.grafana_auth0_domain}/oauth/token"
          api_url       = "https://${var.grafana_auth0_domain}/userinfo"
        }
      }
      # Prometheus datasource is auto-provisioned by this chart. Loki isn't
      # (separate helm_release below) — wired in here instead of via the
      # datasource-sidecar, since there's exactly one and it never changes.
      additionalDataSources = concat([{
        name   = "Loki"
        uid    = "loki"
        type   = "loki"
        access = "proxy"
        url    = "http://loki.${kubernetes_namespace.observability.metadata[0].name}.svc.cluster.local:3100"
        # Från en loggrad till dess trace (pino-instrumenteringen lägger `trace_id` i varje loggrad inom en span).
        jsonData = var.tempo_enabled ? {
          derivedFields = [{
            name          = "trace_id"
            matcherRegex  = "\"trace_id\":\"(\\w+)\""
            url           = "$${__value.raw}"
            datasourceUid = "tempo"
          }]
        } : {}
        }], var.tempo_enabled ? [{
        name   = "Tempo"
        uid    = "tempo"
        type   = "tempo"
        access = "proxy"
        url    = "http://tempo.${kubernetes_namespace.observability.metadata[0].name}.svc.cluster.local:3200"
        # Från ett trace till loggarna för samma trace_id.
        jsonData = {
          tracesToLogsV2 = {
            datasourceUid      = "loki"
            filterByTraceID    = false
            spanStartTimeShift = "-5m"
            spanEndTimeShift   = "5m"
            customQuery        = true
            query              = "{namespace=\"ticketing\"} |= \"$${__trace.traceId}\""
          }
        }
      }] : [])
    }
  })]
}

# docs/plan.md "Observability": Loki + Alloy för loggar och traces.
# Monolithic (renamed from "SingleBinary" upstream) + filesystem storage：
# matches this project's scale — one cluster, no multi-tenant log volume
# that would justify the simple-scalable or microservices deployment modes.
resource "helm_release" "loki" {
  name       = "loki"
  repository = "https://grafana-community.github.io/helm-charts"
  chart      = "loki"
  version    = "19.0.3"
  namespace  = kubernetes_namespace.observability.metadata[0].name

  depends_on = [kubernetes_namespace.observability]

  values = [yamlencode({
    deploymentMode = "Monolithic"
    loki = {
      # Chartet har auth_enabled=true (multi-tenant) som default, och Alloy
      # skickar ingen X-Scope-OrgID → 401 på varje loggbatch, noll loggar
      # sparade. Vi har en tenant (docs/plan.md 7.2).
      auth_enabled = false
      commonConfig = { replication_factor = 1 }
      storage      = { type = "filesystem" }
      limits_config = {
        retention_period = "168h" # 7 dagar — samma princip som backuparna
      }
      compactor = {
        retention_enabled    = true
        delete_request_store = "filesystem"
      }
      # Chartet sätter inget schema åt dig (det är klusterspecifikt) — TSDB
      # + schema v13 är den rekommenderade kombinationen för lokal
      # filesystem-lagring på nyare Loki-versioner.
      schemaConfig = {
        configs = [{
          from         = "2024-01-01"
          store        = "tsdb"
          object_store = "filesystem"
          schema       = "v13"
          index = {
            prefix = "loki_index_"
            period = "24h"
          }
        }]
      }
    }
    singleBinary = {
      replicas = 1
      persistence = {
        storageClass = "hcloud-volumes"
        size         = "10Gi"
      }
    }
    # Chartets validate.yaml kräver dessa satta till 0 i Monolithic-läge —
    # annars tolkas chartets egna default-replikantal för write/read/backend
    # (den "simple scalable"-varianten) som att BÅDA lägena är aktiva samtidigt.
    write   = { replicas = 0 }
    read    = { replicas = 0 }
    backend = { replicas = 0 }
    # Internt kluster-till-kluster-trafik bara (Grafana, Alloy) — ingen
    # extra nginx-gateway framför Loki behövs.
    gateway = { enabled = false }
    # Chartets defaultstorlek för dessa (chunksCache: ~9.6GB, resultsCache:
    # ~1.2GB minne) är dimensionerad för en stor produktionsinstallation —
    # klustrets noder (cpx22, 4GB RAM) rymmer inte det (chunksCache fastnade
    # i Pending: "Insufficient memory"). Query-volymen här motiverar inte
    # cachelagren överhuvudtaget.
    chunksCache  = { enabled = false }
    resultsCache = { enabled = false }
    # Ingen extern lagring att säkerhetskopiera separat — loggarna är
    # debug-hjälp, inte bokföring (docs/plan.md "Backups" gäller bara
    # Postgres).
    test = { enabled = false }
  })]
}

# docs/plan.md 8.7: Tempo som single-binary (samma mönster som Loki: filesystem, en replika). Resurserna är
# hårda krav, eftersom noderna är cpx22 (4 GB): 128Mi begärt, 384Mi tak, och GOMEMLIMIT strax under taket så att
# Go-runtimen städar innan kärnan OOM-dödar podden. 7 dagars retention; Tempo har ingen storleksbaserad
# retention, så diskens tak är PVC:n (5Gi, larm vid 80 %) tillsammans med 10 % sampling i Alloy.
# Chartet: grafana-community/tempo 3.2.0 (Tempo 3.1.0).
resource "helm_release" "tempo" {
  count      = var.tempo_enabled ? 1 : 0
  name       = "tempo"
  repository = "https://grafana-community.github.io/helm-charts"
  chart      = "tempo"
  version    = "3.2.0"
  namespace  = kubernetes_namespace.observability.metadata[0].name

  # kube_prometheus_stack: serviceMonitor nedan kräver att CRD:n redan finns.
  depends_on = [kubernetes_namespace.observability, helm_release.kube_prometheus_stack]

  values = [yamlencode({
    tempo = {
      retention        = "168h"
      reportingEnabled = false
      resources = {
        requests = { cpu = "50m", memory = "128Mi" }
        limits   = { cpu = "500m", memory = "384Mi" }
      }
      extraEnv = [{ name = "GOMEMLIMIT", value = "320MiB" }]
    }
    persistence = {
      enabled          = true
      storageClassName = "hcloud-volumes"
      size             = "5Gi"
    }
    serviceMonitor = { enabled = true }
  })]
}

# docs/plan.md "Observability": OTel-instrumentering (shared/observability/
# src/tracing.ts) exporterar till Alloys OTLP-mottagare redan nu. Tempo
# (traces-backend) kopplas in efter VG — tills då loggar Alloy bara att
# spans togs emot (otelcol.exporter.debug), så pipen är testad innan Fas 6+
# bara behöver byta ut EN exporter-rad, inte instrumentera om fem tjänster.
resource "helm_release" "alloy" {
  name       = "alloy"
  repository = "https://grafana.github.io/helm-charts"
  chart      = "alloy"
  version    = "1.14.2"
  namespace  = kubernetes_namespace.observability.metadata[0].name

  # kube_prometheus_stack: serviceMonitor nedan kräver att CRD:n redan finns.
  # Tempo först (docs/plan.md 8.7): Alloy ska inte börja skicka till en backend som inte finns än.
  depends_on = [helm_release.loki, helm_release.kube_prometheus_stack, helm_release.tempo]

  values = [yamlencode({
    alloy = {
      configMap = {
        create = true
        content = templatefile("${path.module}/alloy-config.alloy.tftpl", {
          tempo_enabled             = var.tempo_enabled
          tempo_sampling_percentage = var.tempo_sampling_percentage
        })
      }
      # otelcol.exporter.debug is still "experimental" upstream. It stays until Tempo is proven
      # (docs/plan.md 8.7); removing it and this setting is a separate last commit.
      stabilityLevel = "experimental"
      # The chart's auto-created Service (below) only exposes ports listed
      # here — it doesn't introspect alloy-config.alloy's otelcol.receiver.otlp
      # block. Services' OTEL_EXPORTER_OTLP_TRACES_ENDPOINT points at
      # alloy.observability.svc.cluster.local:4318.
      extraPorts = [
        {
          name       = "otlp-grpc"
          port       = 4317
          targetPort = 4317
          protocol   = "TCP"
        },
        {
          name       = "otlp-http"
          port       = 4318
          targetPort = 4318
          protocol   = "TCP"
        },
      ]
    }
    # Alloys egna mått (loki_write_dropped_entries_total) skrapas av
    # Prometheus via en ServiceMonitor — utan den kan larmet i
    # infra/k8s/base/monitoring/prometheusrule.yaml aldrig utlösas.
    serviceMonitor = { enabled = true }
  })]
}
