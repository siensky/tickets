#!/usr/bin/env bash
# Växlar klustret till/från lasttestläge (docs/plan.md 7.1), så att inget manuellt
# steg kan glömmas. Körs lokalt med kubectl mot klustret (Tailscale) och terraform
# initierat i infra/terraform.
#
#   scripts/loadtest-mode.sh on [admission_rate_per_minute]   (default 3600)
#   scripts/loadtest-mode.sh off
#
# Det som växlas är medvetet INTE permanent i git:
#  - RATE_LIMIT_ALLOWLISTED_IPS: loadgen-IP:erna går tillbaka till Hetzner när VM:erna
#    rivs och kan hamna hos någon annan, som då skulle kringgå botskyddet.
#  - STRIPE_HOST/STRIPE_PORT/STRIPE_WEBHOOK_SECRET → payment-mock: produktion kör
#    riktigt Stripe-testläge, mocken finns för att inte skicka 50 000 försök till Stripe.
#  - queue_admission_rate_per_minute och payment-mock-repliker.
#
# Fallgropar: `off` får INTE använda `kubectl set env --from=secret/…` (det namnger
# variabeln efter nyckeln) och INTE `kubectl apply` på base-filen (image: …:latest).
# En kvarlämnad literal STRIPE_WEBHOOK_SECRET failar CI:s k8s-dry-run
# ("valueFrom may not be specified when `value` is not empty").
set -euo pipefail

NAMESPACE=ticketing
DATA_NAMESPACE=data
# Migrationen 1700000004000_add-waiting-room-config.ts sätter 300 som default.
DEFAULT_ADMISSION_RATE=300
DEFAULT_LOADTEST_ADMISSION_RATE=3600
LOADTEST_MOCK_REPLICAS=4
NORMAL_MOCK_REPLICAS=1
# Samma värden som payment-mock-Servicen (infra/k8s/base/payment-mock/service.yaml).
MOCK_HOST="payment-mock.${NAMESPACE}.svc.cluster.local"
MOCK_PORT=80

cd "$(dirname "$0")/.."

usage() {
  echo "Användning: $0 on [admission_rate_per_minute] | off" >&2
  exit 1
}

set_admission_rate() {
  local rate=$1
  local updated
  updated=$(kubectl exec -n "$DATA_NAMESPACE" postgres-shard-0-0 -- \
    psql -U postgres -d tickets -v ON_ERROR_STOP=1 -tA \
    -c "UPDATE config SET value = '${rate}' WHERE key = 'queue_admission_rate_per_minute' RETURNING key;")
  [[ -n $updated ]] || { echo "config-nyckeln queue_admission_rate_per_minute hittades inte" >&2; exit 1; }
}

mode_on() {
  local rate=${1:-$DEFAULT_LOADTEST_ADMISSION_RATE}
  # Appen kräver ett positivt heltal (parsePositiveInteger) — 0 stoppar väntrummets insläpp.
  [[ $rate =~ ^[1-9][0-9]{0,6}$ ]] || { echo "admission_rate måste vara ett positivt heltal, fick '$rate'" >&2; exit 1; }

  local ips
  ips=$(terraform -chdir=infra/terraform output -json loadgen_ipv4s | jq -r 'join(",")')
  [[ -n $ips ]] || { echo "Inga loadgen-IP:er (loadgen_node_count = 0?). Skapa VM:erna först." >&2; exit 1; }

  local mock_secret
  mock_secret=$(kubectl get secret tickets-generated-secrets -n "$NAMESPACE" \
    -o jsonpath='{.data.payment-mock-webhook-secret}' | base64 -d)
  [[ -n $mock_secret ]] || { echo "payment-mock-webhook-secret saknas eller är tom" >&2; exit 1; }
  # Allt i en enda ändring (en rollout). Hemligheten går via stdin, aldrig som argument
  # (syns annars i processlistan).
  printf 'STRIPE_WEBHOOK_SECRET=%s\nSTRIPE_HOST=%s\nSTRIPE_PORT=%s\nRATE_LIMIT_ALLOWLISTED_IPS=%s\n' \
    "$mock_secret" "$MOCK_HOST" "$MOCK_PORT" "$ips" \
    | kubectl set env deployment/booking-api -n "$NAMESPACE" --env=- >/dev/null
  kubectl scale deployment/payment-mock -n "$NAMESPACE" --replicas="$LOADTEST_MOCK_REPLICAS"
  set_admission_rate "$rate"
  kubectl rollout status deployment/booking-api -n "$NAMESPACE" --timeout=300s
  kubectl rollout status deployment/payment-mock -n "$NAMESPACE" --timeout=300s

  cat <<EOF

Lasttestläge PÅ (allowlist: $ips, insläpp: $rate/min, payment-mock: $LOADTEST_MOCK_REPLICAS repliker).

Verifiera INNAN en stor körning:
  k6 run -e BASE_URL=https://loadtest.tikknet.se -e EVENT_ID=<uuid> -e AUTH_TOKENS=<tok1,tok2,...> tests/load/smoke.js
  Förväntat: checks 100 %. Kontrollera sedan att ordrarna blev betalda (inte bara 201 från checkout), på båda shardarna:
  kubectl exec -n $DATA_NAMESPACE postgres-shard-0-0 -- psql -U postgres -d tickets -c "SELECT status, count(*) FROM orders GROUP BY status;"
  kubectl exec -n $DATA_NAMESPACE postgres-shard-1-0 -- psql -U postgres -d tickets -c "SELECT status, count(*) FROM orders GROUP BY status;"

Glöm inte: loadgen_node_count i terraform.tfvars ska tillbaka till 0 efteråt (terraform apply körs av dig).
Avsluta med: $0 off
EOF
}

mode_off() {
  local deployment_json idx has_literal
  deployment_json=$(kubectl get deploy booking-api -n "$NAMESPACE" -o json)
  idx=$(jq '.spec.template.spec.containers[0].env | map(.name) | index("STRIPE_WEBHOOK_SECRET")' <<<"$deployment_json")
  has_literal=$(jq ".spec.template.spec.containers[0].env[$idx].value != null" <<<"$deployment_json")
  if [[ $has_literal == true ]]; then
    kubectl patch deploy booking-api -n "$NAMESPACE" --type=json -p="[{\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/env/$idx\",\"value\":{\"name\":\"STRIPE_WEBHOOK_SECRET\",\"valueFrom\":{\"secretKeyRef\":{\"name\":\"tickets-app-secrets\",\"key\":\"stripe-webhook-secret\"}}}}]"
  fi
  kubectl set env deployment/booking-api -n "$NAMESPACE" STRIPE_HOST- STRIPE_PORT- RATE_LIMIT_ALLOWLISTED_IPS- >/dev/null
  kubectl scale deployment/payment-mock -n "$NAMESPACE" --replicas="$NORMAL_MOCK_REPLICAS"
  set_admission_rate "$DEFAULT_ADMISSION_RATE"
  kubectl rollout status deployment/booking-api -n "$NAMESPACE" --timeout=300s

  # Samma dry-run som CI:s k8s-dry-run — fångar en kvarlämnad överskrivning.
  kubectl kustomize infra/k8s/overlays/production | kubectl apply --dry-run=server -f - >/dev/null
  echo "Lasttestläge AV. Dry-run mot produktionsmanifesten OK."
}

case "${1:-}" in
  on) shift; mode_on "$@" ;;
  off) mode_off ;;
  *) usage ;;
esac
