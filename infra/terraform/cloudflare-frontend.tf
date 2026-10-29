# PWA:n (apps/web) på apex-domänen (docs/plan.md "Appen på <domän>").
# `deploy.yml`:s deploy-frontend-jobb laddar bara upp dist/ till R2 under
# prefixet "frontend/" — ingenting kopplade tidigare den uppladdningen
# till själva domänen, så tikknet.se hade ingen DNS-post alls
# (ERR_NAME_NOT_RESOLVED, hittat live efter första riktiga deployen).
#
# Löst med en Worker i stället för en vanlig R2 "Custom Domain", av två
# skäl:
#  1. Bucketen delas med de nattliga databas-backuperna
#     (docs/adr/0005-backup-storage-r2.md). En Custom Domain gör HELA
#     bucketen publik på domänen — det hade exponerat backup-dumparna
#     på https://tikknet.se/<backup-nyckel>, inte bara "frontend/"-
#     prefixet. Workerns R2-binding (workers/frontend-proxy.js) läser
#     objekt internt och gör aldrig bucketen publik.
#  2. React-appens klientsidiga routing (/events/:id, /my-tickets, …)
#     kräver fallback till index.html för sökvägar utan en egen fil —
#     rå R2 Custom Domain saknar det inbyggt (till skillnad från
#     Cloudflare Pages), Workern implementerar det själv.
resource "cloudflare_workers_script" "frontend_proxy" {
  account_id     = var.cloudflare_account_id
  script_name    = "tickets-frontend-proxy"
  content_file   = "${path.module}/workers/frontend-proxy.js"
  content_sha256 = filesha256("${path.module}/workers/frontend-proxy.js")
  main_module    = "frontend-proxy.js"

  compatibility_date = "2026-01-01"

  bindings = [{
    name        = "FRONTEND_BUCKET"
    type        = "r2_bucket"
    bucket_name = var.r2_bucket_name
  }]
}

# Skapar sin egen DNS-post åt zonen (till skillnad från en Workers
# Route, som kräver att posten redan finns) — det är hela poängen med
# "Custom Domain" i stället för en Route här: apex hade ingen post
# innan detta.
resource "cloudflare_workers_custom_domain" "frontend" {
  account_id = var.cloudflare_account_id
  zone_id    = data.cloudflare_zone.this.zone_id
  hostname   = var.domain_name
  service    = cloudflare_workers_script.frontend_proxy.script_name
}

# cdn.<domän> (docs/plan.md 7.19): eventbilder och varumärkesfiler. Egen Worker i
# stället för frontend-proxy, eftersom den har en vitlista (bara images/ och brand/)
# — bucketen innehåller även databasbackuperna (docs/adr/0005-backup-storage-r2.md).
# CORS-origins (apex och scan.) skickas in som binding så att Workern inte hårdkodar
# domänen.
resource "cloudflare_workers_script" "cdn_proxy" {
  account_id     = var.cloudflare_account_id
  script_name    = "tickets-cdn-proxy"
  content_file   = "${path.module}/workers/cdn-proxy.js"
  content_sha256 = filesha256("${path.module}/workers/cdn-proxy.js")
  main_module    = "cdn-proxy.js"

  compatibility_date = "2026-01-01"

  bindings = [
    {
      name        = "CDN_BUCKET"
      type        = "r2_bucket"
      bucket_name = var.r2_bucket_name
    },
    {
      name = "ALLOWED_ORIGINS"
      type = "plain_text"
      text = "https://${var.domain_name},https://scan.${var.domain_name}"
    },
  ]
}

resource "cloudflare_workers_custom_domain" "cdn" {
  account_id = var.cloudflare_account_id
  zone_id    = data.cloudflare_zone.this.zone_id
  hostname   = "cdn.${var.domain_name}"
  service    = cloudflare_workers_script.cdn_proxy.script_name
}
