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
# /health/live-regeln är kvar som ursprungsbeviset på att mekaniken
# fungerar. Fas 5 lägger till de TVÅ riktiga reglerna den kommenterade
# planen pekade framåt mot: venue-geometrin (statisk, lång cache — samma
# layout återanvänds av varje event på den arenan) och per-event
# stolsstatus (kort cache, matchar klientens 2 s polling, se
# services/booking-api/src/controllers/seatmap-controller.ts). Båda
# routerna är avsiktligt anonyma och sätter aldrig cookies — annars
# cachar Cloudflare dem inte alls.
resource "cloudflare_ruleset" "edge_cache" {
  zone_id     = data.cloudflare_zone.this.zone_id
  name        = "tickets-edge-cache"
  description = "Cache-regler för anonyma, cookie-fria GET-svar"
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
    },
    {
      # "matches" (regex) kräver Business-plan eller WAF Advanced-
      # tillägget ("not entitled", hittat live vid första riktiga
      # applyn av den här regeln) — starts_with()/contains() ger samma
      # praktiska träffbild (båda /venues/:id/sections OCH
      # /venues/:id/sections/:id/seats, precis som den ursprungliga
      # regexen utan $-ankare redan gjorde) utan att kräva entitlement.
      # OBS: wirefilter blandar de två formerna — starts_with/ends_with
      # är FUNKTIONSANROP (`starts_with(fält, "x")`, "expected
      # ComparisonOp" annars), medan contains är INFIX
      # (`fält contains "x"`, "unknown identifier" som funktionsanrop).
      # Båda felen hittade live, i tur och ordning.
      description = "Cacha arenageometrin (venue-sektioner + stolsgeometri) i 30 dagar vid kanten — statisk layout, docs/plan.md 'Arenakartans geometri'"
      expression  = "(starts_with(http.request.uri.path, \"/venues/\") and http.request.uri.path contains \"/sections\" and http.host eq \"api.${var.domain_name}\")"
      action      = "set_cache_settings"
      action_parameters = {
        cache = true
        edge_ttl = {
          mode    = "override_origin"
          default = 2592000
        }
      }
    },
    {
      # Samma skäl som ovan — ends_with "/seats/status" är tillräckligt
      # specifikt (enda routen i API:et med den suffixen, se
      # services/booking-api/src/routes/seatmap.ts).
      description = "Cacha per-event stolsstatus i 1s vid kanten, matchar klientens 2s polling — docs/plan.md 'Stolarnas status'"
      expression  = "(starts_with(http.request.uri.path, \"/events/\") and ends_with(http.request.uri.path, \"/seats/status\") and http.host eq \"api.${var.domain_name}\")"
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
