# Bevis: deploy utan nertid

Mål (docs/plan.md 7.3): `http_req_failed` = 0 medan `booking-api` rullas ut under last.
Körordning: `docs/runbook.md` "Bevis: deploy utan nertid". Motivering till att deployen är
`kubectl rollout restart` och inte en merge: `docs/forsvar.md`.

## Körning

| Fält | Värde |
|---|---|
| Datum och tid | _fylls i efter körningen_ |
| Profil | `tests/load/deploy-under-load.js`: 10 iterationer/s i 5 min |
| Event | _eventId (efter `reset-sale`)_ |
| Deploy | `kubectl rollout restart deployment/booking-api -n ticketing`, två gånger (efter ca 1 och 3 min) |
| Loadtest-läge | `loadtest-mode on` |

## Resultat från klienten (k6)

| Mått | Krav | Utfall |
|---|---|---|
| `http_req_failed` | 0,00 % | _fylls i_ |
| `dropped_iterations` | 0 | _fylls i_ |
| Thresholds | alla gröna, k6 avslutar med 0 | _fylls i_ |
| Totalt antal requests | — | _fylls i_ |

k6-summary (`/tmp/zero-downtime-summary.json`, relevanta delar): _klistras in_

## Resultat från servern (ingress-nginx)

Fråga i Grafana Explore: `sum(nginx_ingress_controller_requests{status=~"5..", service!="metrics-blackhole"})`.
Panelen "ingress-5xx/s" ser inte de första 5xx-svaren (en ny serie startar på 1 och `rate()`
räknar inte det första hoppet), därför läses råräknaren före och efter.

| | Värde |
|---|---|
| Före körningen | _fylls i_ |
| Efter körningen | _fylls i_ |
| Skillnad (krav: 0) | _fylls i_ |

## Grafana

_Skärmdump av "Autoscaling & lasttest" → zero-downtime-raden över körningens tidsintervall,
med deploy-annotationerna synliga._

## Slutsats

_Fylls i efter körningen._
