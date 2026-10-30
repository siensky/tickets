/**
 * Seedar arenor och 20 events från `seed/venues.csv` och `seed/events.csv`
 * (docs/plan.md 7.6; ersätter `seed-demo-events.ts`). Körs MANUELLT mot prod
 * via port-forward (docs/runbook.md "Seed: events från CSV"):
 * `pnpm run seed-events-from-csv [seed-katalog]` (standard `seed`, relativt
 * där kommandot körs, d.v.s. repo-roten).
 *
 * Validerar HELA CSV:erna (okänd venue, fel datumformat, saknad bild i
 * `seed/images/` …) innan något skrivs och avbryter med radnummer. Allt eller
 * inget. Lasttestets 5 000-platsersarena och event lämnas orörda: bara de
 * arenor och event som står i CSV:erna rörs.
 *
 * Idempotent: id:n härleds ur namn och slug. Arenor, sektioner och event
 * uppdateras vid omkörning, stolar läggs bara till (se
 * repositories/csv-seed-repository.ts). Varje event skrivs bara till sin egen
 * shard (`getPoolForEvent`), samma regel som `seed-demo-events.ts`. Bilderna i
 * `seed/images/` laddas upp till R2 av `deploy-frontend`, inte av det här
 * skriptet.
 */
import {
  closeShardPools,
  createShardPools,
  getGlobalPool,
  getPoolForEvent,
  withTransaction,
  type ShardPools,
} from '@tickets/db';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSeedPlan, type SeedPlan } from '../mappers/seed-csv-mapper.js';
import {
  insertEventSeats,
  insertVenueSeats,
  upsertEvent,
  upsertSections,
  upsertVenue,
} from '../repositories/csv-seed-repository.js';

const DEFAULT_SEED_DIR = 'seed';

export function loadPlan(seedDir: string): SeedPlan {
  const read = (name: string): string => readFileSync(resolve(seedDir, name), 'utf8');
  const imageFiles = new Set(readdirSync(resolve(seedDir, 'images')));
  return buildSeedPlan(read('venues.csv'), read('events.csv'), imageFiles);
}

/** Arenorna först (global-poolen), sedan varje event i en egen transaktion på sin shard. */
export async function writePlan(shardPools: ShardPools, plan: SeedPlan): Promise<void> {
  await withTransaction(getGlobalPool(shardPools), async (client) => {
    for (const venue of plan.venues) {
      await upsertVenue(client, venue);
      await upsertSections(client, venue.id, venue.sections);
      await insertVenueSeats(client, venue.id, venue.seats);
    }
  });
  for (const event of plan.events) {
    await withTransaction(getPoolForEvent(shardPools, event.id), async (client) => {
      await upsertEvent(client, event);
      await insertEventSeats(client, event);
    });
  }
}

async function main(): Promise<void> {
  const plan = loadPlan(process.argv.slice(2).find((arg) => arg !== '--') ?? DEFAULT_SEED_DIR);
  const shardPools = createShardPools();
  try {
    await writePlan(shardPools, plan);
  } finally {
    await closeShardPools(shardPools);
  }
  process.stdout.write(
    `Seeded ${String(plan.venues.length)} venues and ${String(plan.events.length)} events.\n`,
  );
}

const isMain =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
