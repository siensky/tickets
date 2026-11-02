/**
 * Tar bort de fem gamla demo-eventen (docs/plan.md 8.3) som `seed-demo-events.ts` la i produktion, utan
 * bild och på en liten 30-sätesarena. Rör aldrig lasttestets event eller CSV-eventen: bara de fem fasta id:na.
 *
 *   node dist/scripts/remove-demo-events.js            # torrkörning: listar vad som skulle tas bort
 *   node dist/scripts/remove-demo-events.js --apply    # exporterar raderna, tar sedan bort
 *
 * Skyddsräcken: per event, i EN transaktion med eventraden låst, kontrolleras att det inte finns betalda
 * eller pågående ordrar/reservationer (annars vägras det eventet och inget av dess rader raderas), raderna
 * exporteras till en fil (0600, aldrig i repot) FÖRE första DELETE, och därefter raderas de. Saknade event
 * hoppas över, så en avbruten körning går att köra om. Väntrummets Redis-nycklar för eventen töms också.
 * Exportfilen innehåller personuppgifter (QR-token, betalningssvar): förvara och radera den därefter.
 * Körs MANUELLT (port-forward som `reset-sale`), aldrig automatiskt och aldrig mitt under en demo.
 */
import {
  closeShardPools,
  createShardPools,
  getPoolForEvent,
  type ShardPools,
} from '@tickets/db';
import { closeRedisClient, createRedisClient, drainWaitingRoom } from '@tickets/redis';
import { realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  countBlockingRows,
  exportEventRows,
  removeEvent,
  type EventExport,
} from '../repositories/demo-event-removal-repository.js';

/** Samma id:n som `seed-demo-events.ts`. */
export const DEMO_EVENT_IDS: readonly string[] = [
  '00000000-0000-4000-8000-000000000201',
  '00000000-0000-4000-8000-000000000202',
  '00000000-0000-4000-8000-000000000203',
  '00000000-0000-4000-8000-000000000204',
  '00000000-0000-4000-8000-000000000205',
];

export interface RemovalPlan {
  readonly eventId: string;
  readonly exists: boolean;
  readonly blockingRows: number;
  readonly rows: EventExport;
}

/** Torrkörningens underlag: bara SELECT. `exists` är sant om någon tabell har rader för eventet. */
export async function planRemoval(
  shardPools: ShardPools,
  eventIds: readonly string[],
): Promise<RemovalPlan[]> {
  const plans: RemovalPlan[] = [];
  for (const eventId of eventIds) {
    const client = await getPoolForEvent(shardPools, eventId).connect();
    try {
      const rows = await exportEventRows(client, eventId);
      plans.push({
        eventId,
        exists: Object.values(rows).some((tableRows) => tableRows.length > 0),
        blockingRows: await countBlockingRows(client, eventId),
        rows,
      });
    } finally {
      client.release();
    }
  }
  return plans;
}

/** Skriver ett events export till en ny fil (flaggan `wx` skriver aldrig över, 0600 = bara ägaren). */
export function writeExportFile(path: string, rows: EventExport): void {
  writeFileSync(path, JSON.stringify(rows, null, 2), { mode: 0o600, flag: 'wx' });
}

/** Tar bort varje event i sin egen transaktion. Returnerar de event som faktiskt raderades. */
export async function applyRemoval(
  shardPools: ShardPools,
  eventIds: readonly string[],
  exportPathFor: (eventId: string) => string,
): Promise<string[]> {
  const removed: string[] = [];
  for (const eventId of eventIds) {
    const client = await getPoolForEvent(shardPools, eventId).connect();
    try {
      const deleted = await removeEvent(client, eventId, (rows) =>
        writeExportFile(exportPathFor(eventId), rows),
      );
      if (deleted !== undefined) {
        removed.push(eventId);
        process.stdout.write(`Raderade ${eventId}: ${JSON.stringify(deleted)}\n`);
      }
    } finally {
      client.release();
    }
  }
  return removed;
}

function printPlans(plans: readonly RemovalPlan[]): void {
  for (const plan of plans) {
    const counts = Object.entries(plan.rows).map(
      ([table, rows]) => `${table}=${String(rows.length)}`,
    );
    process.stdout.write(
      `${plan.eventId}: ${plan.exists ? counts.join(' ') : 'finns inte'}, betalda/pågående: ${String(plan.blockingRows)}\n`,
    );
  }
}

async function main(): Promise<void> {
  const shouldApply = process.argv.includes('--apply');
  const shardPools = createShardPools();
  try {
    printPlans(await planRemoval(shardPools, DEMO_EVENT_IDS));
    if (!shouldApply) {
      process.stdout.write('Torrkörning: inget raderat. Kör med --apply för att ta bort.\n');
      return;
    }
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const exportPathFor = (eventId: string): string =>
      join(homedir(), `demo-events-export-${stamp}-${eventId}.json`);
    const removed = await applyRemoval(shardPools, DEMO_EVENT_IDS, exportPathFor);
    const redis = createRedisClient(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
    try {
      for (const eventId of removed) {
        await drainWaitingRoom(redis, eventId);
      }
    } finally {
      await closeRedisClient(redis);
    }
    process.stdout.write(
      `Exporterade raderna till ${join(homedir(), 'demo-events-export-*')}.\n`,
    );
  } finally {
    await closeShardPools(shardPools);
  }
}

// Samma symlänk-säkra mönster som övriga skript.
const isMain =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
