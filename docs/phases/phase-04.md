# Fas 4 — Observability, larm och backups

**Status:** klar och mergad. **Utfall:** [`phase-status.md`](../phase-status.md) "Läget efter Fas 4".

## Mål

**Klar efter review** (se nedan) — G: metrics, logging, backup

## Omfattning

Planerat datum: 29–31/10.

kube-prometheus-stack, Loki + Alloy, OTel-instrumentering. **`retentionSize` + PVC-dimensionering.** Dashboards, `oversell_prevented_total`, larm → Slack. Nattlig `pg_dump` av båda shardarna → R2 (se `docs/adr/0005-backup-storage-r2.md`) + runbook-skript för återställningsövningen (ej ännu körd mot riktigt kluster — kräver Tailscale-åtkomst). **Fas 3-review-noten löst:** den egna `rabbitmq_queue_messages_ready`-gaugen (queue-depth-metric.ts) är borttagen; RabbitMQs eget `rabbitmq_prometheus`-plugin är källan nu.

## Beroenden

Fas 3 klar.

## Berör

[`specification.md`](../specification.md): "Observability och backups".

## Implementationssteg

Fasen planerades som raden i fastabellen ("Omfattning" ovan), utan numrerade steg.

## Beslut under fasen

**Fas 4 — löst efter ditt beslut om oversold-stolar:** en stol som förlorar
`tickets_valid_seat_unique`-racet återbetalas individuellt (Stripe partial refund,
`order.seat_refunded`-mejl) medan resten av ordern bekräftas som vanligt
(`payment-refund-service.ts`, `mintTicketsForSeats`s per-stol SAVEPOINT). Om ALLA
stolar i en order krockar faller den tillbaka till en full återbetalning (samma väg
som en utgången reservation). En redelivery efter en krasch MELLAN Stripe-anropet och
outbox-skrivningen räknar om vilka stolar som saknar biljett direkt från
`tickets`-tabellen (ingen egen "pending"-markör) — se kommentarerna i
`payment-consumer-service.ts`/`payment-refund-service.ts`.

## Acceptanskriterier

Inte formulerat som egna kriterier när fasen byggdes. Målet ovan och kraven i
[`specification.md`](../specification.md) "Kraven och var de uppfylls" gäller.
