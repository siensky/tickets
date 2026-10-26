/**
 * Återställer ett events försäljningsdata mellan `normal-sale` och
 * `spike-sale` (docs/plan.md "Lasttest": "Reset mellan körningarna").
 * Samtliga `seats` för eventet sätts till `available`, och
 * `reservations`/`orders`/`tickets`/`payments` töms helt, OCH
 * väntrummets ZSET i Redis dräneras — så nästa körning startar från
 * exakt samma 5 000 tillgängliga biljetter OCH en tom kö, inte en
 * kvarlämnad backlog av tusentals ännu-levande kötoken som äter
 * insläppskvoten innan en enda ny VU hunnit joina (upptäckt i Fas 6-
 * reviewn).
 *
 * VIKTIGT: körs först när outbox/RabbitMQ hunnit tömmas efter
 * `normal-sale` — annars bearbetar notification-worker fortfarande
 * meddelanden för ordrar som redan raderats här.
 *
 * Eget engångsskript i scheduler-worker (docs/rules.md §11a-kontexten:
 * tjänsten äger redan de schemalagda jobben), körs MANUELLT
 * (`node dist/scripts/reset-sale.js <eventId>`), ALDRIG automatiskt —
 * ett skript som tömmer ordrar ska inte kunna triggas av ett misstag i
 * CI (docs/plan.md).
 *
 * Rör INTE `outbox`/`processed_messages`/`idempotency_keys` — de har sin
 * egen 30-dagars retentionsprincip (docs/plan.md "Databas") och en
 * färsk k6-körning genererar egna, unika idempotensnycklar oavsett.
 * Rör heller inte `admitted:<event>:<token>`/seatmark-nycklarna i Redis
 * — de är scopade per kötoken-id, och k6 genererar alltid FÄRSKA
 * kötoken (slumpade av booking-api vid join), så gamla sådana nycklar
 * kan aldrig krocka med nästa körnings nya tokens; de har egna TTL:er
 * och självstädar.
 */
import { closeShardPools, createShardPools, getPoolForEvent } from '@tickets/db';
import { closeRedisClient, createRedisClient, drainWaitingRoom } from '@tickets/redis';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resetSaleForEvent } from '../repositories/sale-reset-repository.js';

async function main(): Promise<void> {
  const eventId = process.argv[2];
  if (eventId === undefined || eventId.length === 0) {
    process.stderr.write('Usage: node dist/scripts/reset-sale.js <eventId>\n');
    process.exitCode = 1;
    return;
  }
  const shardPools = createShardPools();
  const redis = createRedisClient(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
  try {
    const client = await getPoolForEvent(shardPools, eventId).connect();
    let counts;
    try {
      counts = await resetSaleForEvent(client, eventId);
    } finally {
      client.release();
    }
    const drainedQueueTokens = await drainWaitingRoom(redis, eventId);
    process.stdout.write(
      `Reset event ${eventId}: ${String(counts.seatsReleased)} seats released, ` +
        `${String(counts.reservationsDeleted)} reservations, ${String(counts.ordersDeleted)} orders, ` +
        `${String(counts.ticketsDeleted)} tickets, ${String(counts.paymentsDeleted)} payments deleted, ` +
        `${String(drainedQueueTokens.length)} queued tokens drained.\n`,
    );
  } finally {
    await closeRedisClient(redis);
    await closeShardPools(shardPools);
  }
}

// Samma symlänk-säkra mönster som src/index.ts och tests/e2e/seed.ts —
// se deras kommentarer för varför `import.meta.url` inte jämförs direkt
// mot `process.argv[1]`.
const isMain =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
