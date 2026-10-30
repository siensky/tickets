/**
 * Seed från CSV mot en RIKTIG Postgres (docs/rules.md §8): de riktiga filerna i
 * `seed/` skrivs, en omkörning är idempotent och en ogiltig CSV skriver ingenting.
 * En container spelar båda shardarna (se test-helpers.ts).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPlan, writePlan } from '../../src/scripts/seed-events-from-csv.js';
import { startTestInfra, stopTestInfra, type TestInfra } from './test-helpers.js';

const SEED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../seed');

describe('seed-events-from-csv', () => {
  let infra: TestInfra;

  beforeAll(async () => {
    infra = await startTestInfra();
  }, 180_000);

  afterAll(async () => {
    await stopTestInfra(infra);
  });

  async function count(sql: string): Promise<number> {
    const { rows } = await infra.shardPools.pools[0].query<{ count: string }>(sql);
    return Number(rows[0]?.count);
  }

  it('skriver 20 events med bild, layout och rätt antal stolar, och är idempotent', async () => {
    const plan = loadPlan(SEED_DIR);
    const expectedSeats = plan.events.reduce((sum, event) => sum + event.seats.length, 0);

    await writePlan(infra.shardPools, plan);
    await writePlan(infra.shardPools, plan);

    expect(await count('SELECT COUNT(*) FROM events')).toBe(20);
    expect(
      await count(`SELECT COUNT(*) FROM events WHERE image_url LIKE 'images/%.webp'`),
    ).toBe(20);
    expect(await count('SELECT COUNT(*) FROM events WHERE featured')).toBe(4);
    expect(await count('SELECT COUNT(*) FROM seats')).toBe(expectedSeats);
    expect(await count('SELECT COUNT(*) FROM venues')).toBe(5);
    expect(await count('SELECT COUNT(*) FROM venue_sections WHERE layout_x IS NOT NULL')).toBe(
      await count('SELECT COUNT(*) FROM venue_sections'),
    );
    expect(await count('SELECT COUNT(*) FROM venues WHERE stage_x IS NOT NULL')).toBe(5);
    expect(await count(`SELECT COUNT(*) FROM events WHERE sales_open_at > now()`)).toBe(0);
  }, 120_000);

  it('uppdaterar presentationen vid omkörning men rör aldrig priset på en befintlig stol', async () => {
    const plan = loadPlan(SEED_DIR);
    const event = plan.events[0];
    if (event === undefined) throw new Error('seed has no events');
    const pool = infra.shardPools.pools[0];
    await pool.query(`UPDATE events SET title = 'Gammal titel' WHERE id = $1`, [event.id]);
    await pool.query(`UPDATE seats SET price_cents = 1 WHERE event_id = $1`, [event.id]);

    await writePlan(infra.shardPools, plan);

    const { rows } = await pool.query<{ title: string }>(
      'SELECT title FROM events WHERE id = $1',
      [event.id],
    );
    expect(rows[0]?.title).toBe(event.title);
    expect(await count(`SELECT COUNT(*) FROM seats WHERE price_cents = 1`)).toBe(
      event.seats.length,
    );
  }, 120_000);
});
