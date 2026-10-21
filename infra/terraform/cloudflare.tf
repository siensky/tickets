# docs/forsvar.md "Varför DNS-01 i stället för HTTP-01": SSL-läge ska bli
# Full (strict) — Flexible skickar HTTP mot ett origin som bara lyssnar på
# 443. MEN strict validerar origin-certifikatet mot publika CA:er, och
# Let's Encrypt staging-certifikat är AVSIKTLIGT inte betrodda av någon —
# det är hela poängen med staging. Kör vi strict samtidigt som
# letsencrypt_use_staging = true (docs/plan.md "staging först") får varje
# request 526 "Invalid SSL certificate" så fort cert-manager utfärdar sitt
# första certifikat.
#
# Läget kopplas därför till samma flagga som styr vilken ClusterIssuer som
# faktiskt används (var.letsencrypt_use_staging): "full" (validerar inte
# certifikatets utfärdare, bara att TLS fungerar) under staging, "strict"
# när vi gått över till produktionscertet. Se docs/forsvar.md "Varför är
# Cloudflares SSL-läge kopplat till letsencrypt_use_staging?".
resource "cloudflare_zone_setting" "ssl_mode" {
  zone_id    = data.cloudflare_zone.this.zone_id
  setting_id = "ssl"
  value      = var.letsencrypt_use_staging ? "full" : "strict"
}

# docs/plan.md "Realtid": edge-cachen är en förutsättning, inte ett
# antagande — explicit Cache Rule i stället för att förlita sig på
# Cloudflares standardbeteende för dynamiska svar.
#
# Matchar /health/live i Fas 1 som bevis på att mekaniken fungerar (det är
# den enda anonyma, cookie-fria GET-routen som finns än). Samma regel
# pekas om mot det riktiga stolsstatus-endpointet när det byggs i Fas 2/3
# — se docs/plan.md "Realtid" och "Hit ratio mäts i Fas 1".
resource "cloudflare_ruleset" "edge_cache" {
  zone_id     = data.cloudflare_zone.this.zone_id
  name        = "tickets-edge-cache"
  description = "Cache-regler för anonyma, cookie-fria GET-svar (walking-skeleton-bevis: /health/live)"
  kind        = "zone"
  phase       = "http_request_cache_settings"

  rules = [
    {
      description = "Cacha /health/live i 1s vid kanten (bevis på cache-mekaniken, se docs/plan.md)"
      expression  = "(http.request.uri.path eq \"/health/live\" and http.host eq \"api.${var.domain_name}\")"
      action      = "set_cache_settings"
      action_parameters = {
        cache = true
        edge_ttl = {
          mode    = "override_origin"
          default = 1
        }
      }
    }
  ]
}
