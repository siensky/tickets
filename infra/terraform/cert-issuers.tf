# docs/forsvar.md "Varför DNS-01 i stället för HTTP-01": ingen port 80
# behövs, wildcard-cert på köpet, inget bootstrap-problem med Cloudflare
# Full (strict). docs/plan.md: staging-issuer tills kedjan är stabil,
# byt till prod en gång — LE ger 5 identiska cert/vecka.

resource "time_sleep" "wait_for_cert_manager_crds" {
  depends_on      = [helm_release.cert_manager]
  create_duration = "30s"
}

resource "kubernetes_manifest" "cluster_issuer_staging" {
  depends_on = [time_sleep.wait_for_cert_manager_crds, kubernetes_secret.cloudflare_api_token]

  manifest = {
    apiVersion = "cert-manager.io/v1"
    kind       = "ClusterIssuer"
    metadata = {
      name = "letsencrypt-staging"
    }
    spec = {
      acme = {
        server = "https://acme-staging-v02.api.letsencrypt.org/directory"
        email  = var.letsencrypt_email
        privateKeySecretRef = {
          name = "letsencrypt-staging-account-key"
        }
        solvers = [
          {
            dns01 = {
              cloudflare = {
                email = var.letsencrypt_email
                apiTokenSecretRef = {
                  name = kubernetes_secret.cloudflare_api_token.metadata[0].name
                  key  = "api-token"
                }
              }
            }
          }
        ]
      }
    }
  }
}

resource "kubernetes_manifest" "cluster_issuer_production" {
  depends_on = [time_sleep.wait_for_cert_manager_crds, kubernetes_secret.cloudflare_api_token]

  manifest = {
    apiVersion = "cert-manager.io/v1"
    kind       = "ClusterIssuer"
    metadata = {
      name = "letsencrypt-production"
    }
    spec = {
      acme = {
        server = "https://acme-v02.api.letsencrypt.org/directory"
        email  = var.letsencrypt_email
        privateKeySecretRef = {
          name = "letsencrypt-production-account-key"
        }
        solvers = [
          {
            dns01 = {
              cloudflare = {
                email = var.letsencrypt_email
                apiTokenSecretRef = {
                  name = kubernetes_secret.cloudflare_api_token.metadata[0].name
                  key  = "api-token"
                }
              }
            }
          }
        ]
      }
    }
  }
}

# Vilken issuer Ingress-resurserna faktiskt pekar på, styrt av
# var.letsencrypt_use_staging (docs/plan.md "Certifikat — DNS-01, och
# staging först"). Används som annotation-värde i infra/k8s-manifesten.
output "cert_manager_cluster_issuer" {
  value = var.letsencrypt_use_staging ? "letsencrypt-staging" : "letsencrypt-production"
}
