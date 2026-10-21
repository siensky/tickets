# docs/forsvar.md "Varför DNS-01 i stället för HTTP-01": ingen port 80
# behövs, wildcard-cert på köpet, inget bootstrap-problem med Cloudflare
# Full (strict). docs/plan.md: staging-issuer tills kedjan är stabil,
# byt till prod en gång — LE ger 5 identiska cert/vecka.
#
# ClusterIssuers skapas med "kubectl apply", INTE med kubernetes_manifest.
# kubernetes_manifest kräver en levande API-anslutning OCH det färdiga
# CRD-schemat redan vid plan-tid — på ett nytt kluster är cert-managers
# CRD:er inte installerade när planen görs, så resursen kan aldrig lyckas
# i samma körning som installerar cert-manager. Inget "depends_on" eller
# "time_sleep" hjälper, eftersom begränsningen ligger i planfasen och inte
# i exekveringsordningen. Se docs/forsvar.md "Varför skapas ClusterIssuers
# med kubectl i stället för kubernetes_manifest?".
resource "null_resource" "cluster_issuers" {
  depends_on = [
    helm_release.cert_manager,
    kubernetes_secret.cloudflare_api_token,
  ]

  # control_plane_id måste ingå: ett nytt kluster har inga issuers, och
  # utan den här triggern anser Terraform att resursen redan är klar och
  # kör aldrig om provisionern (samma fälla som fetch_kubeconfig hade).
  triggers = {
    control_plane_id = hcloud_server.control_plane.id
    email            = var.letsencrypt_email
    token_secret     = kubernetes_secret.cloudflare_api_token.metadata[0].name
  }

  provisioner "local-exec" {
    command = <<-EOT
      set -e
      if ! command -v kubectl >/dev/null 2>&1; then
        echo "kubectl krävs för att skapa ClusterIssuers men hittades inte i PATH." >&2
        exit 1
      fi
      export KUBECONFIG="${path.module}/.kube/config"

      # Deterministisk väntan på att CRD:n faktiskt är etablerad, i
      # stället för att hoppas att en fast fördröjning räcker.
      kubectl wait --for=condition=established --timeout=180s \
        crd/clusterissuers.cert-manager.io

      emit_issuer() {
        issuer_name=$1
        acme_server=$2
        {
          echo "apiVersion: cert-manager.io/v1"
          echo "kind: ClusterIssuer"
          echo "metadata:"
          echo "  name: $issuer_name"
          echo "spec:"
          echo "  acme:"
          echo "    server: $acme_server"
          echo "    email: ${var.letsencrypt_email}"
          echo "    privateKeySecretRef:"
          echo "      name: $issuer_name-account-key"
          echo "    solvers:"
          echo "      - dns01:"
          echo "          cloudflare:"
          echo "            email: ${var.letsencrypt_email}"
          echo "            apiTokenSecretRef:"
          echo "              name: ${kubernetes_secret.cloudflare_api_token.metadata[0].name}"
          echo "              key: api-token"
        } | kubectl apply -f -
      }

      emit_issuer letsencrypt-staging https://acme-staging-v02.api.letsencrypt.org/directory
      emit_issuer letsencrypt-production https://acme-v02.api.letsencrypt.org/directory
    EOT
  }
}

# Vilken issuer Ingress-resurserna faktiskt pekar på, styrt av
# var.letsencrypt_use_staging (docs/plan.md "Certifikat — DNS-01, och
# staging först"). Används som annotation-värde i infra/k8s-manifesten.
output "cert_manager_cluster_issuer" {
  value = var.letsencrypt_use_staging ? "letsencrypt-staging" : "letsencrypt-production"
}
