/**
 * `remove-demo-events` mot en RIKTIG Postgres (docs/plan.md 8.3, docs/rules.md §8). En container spelar
 * båda shardarna (se test-helpers.ts). Varje test får sitt eget event-id och städar i `afterEach`.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { applyRemoval, planRemoval } from '../../src/scripts/remove-demo-events.js';
import { startTestInfra, stopTestInfra, type TestInfra } from './test-helpers.js';

const TABLES = [
  'ticket_scans',
  'tickets',
  'payments',
  'orders',
  'reservations',
  'waitlist',
  'seats',
];

describe('remove-demo-events', () => {
  let infra: TestInfra;
  const created: string[] = [];
  const files: string[] = [];

  beforeAll(async () => {
    infra = await startTestInfra();
  }, 180_000);

  afterEach(async () => {
    const pool = infra.shardPools.pools[0];
    for (const eventId of created.splice(0)) {
      for (const table of TABLES) {
        await pool.query(`DELETE FROM ${table} WHERE event_id = $1`, [eventId]);
      }
      await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
    }
    for (const file of files.splice(0)) {
      rmSync(file, { force: true });
    }
  });

  afterAll(async () => {
    await stopTestInfra(infra);
  });

  /** Ett event med en rad i VARJE tabell skriptet rör, så främmande nycklars ordning testas på riktigt. */
  async function seedEvent(options: {
    orderStatus: 'paid' | 'pending' | 'cancelled';
    reservationStatus?: 'active' | 'expired';
  }): Promise<string> {
    const pool = infra.shardPools.pools[0];
    const eventId = randomUUID();
    const [orderId, reservationId, seatId, ticketId] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    created.push(eventId);
    await pool.query(
      `INSERT INTO events (id, venue_id, title, artist, starts_at, sales_open_at, sales_close_at)
       VALUES ($1, gen_random_uuid(), 'Demo', 'Demo', now() + interval '7 days',
               now() - interval '1 day', now() + interval '6 days')`,
      [eventId],
    );
    await pool.query(
      `INSERT INTO reservations (id, event_id, queue_token_id, status, expires_at, release_after)
       VALUES ($1, $2, $3, $4, now() + interval '5 minutes', now() + interval '6 minutes')`,
      [reservationId, eventId, randomUUID(), options.reservationStatus ?? 'expired'],
    );
    await pool.query(
      `INSERT INTO seats (id, event_id, venue_seat_id, section_id, row, number, ticket_number, price_cents)
       VALUES ($1, $2, gen_random_uuid(), gen_random_uuid(), 'A', 1, $3, 1000)`,
      [seatId, eventId, `T-${eventId}`],
    );
    await pool.query(
      `INSERT INTO orders (id, event_id, user_id, reservation_id, total_cents, status)
       VALUES ($1, $2, $3, $4, 1000, $5)`,
      [orderId, eventId, randomUUID(), reservationId, options.orderStatus],
    );
    await pool.query(
      `INSERT INTO payments (event_id, order_id, provider, provider_ref, idempotency_key, amount_cents, status)
       VALUES ($1, $2, 'stripe', $3, $4, 1000, 'pending')`,
      [eventId, orderId, `cs_${orderId}`, randomUUID()],
    );
    await pool.query(
      `INSERT INTO tickets (id, event_id, order_id, seat_id, qr_token, status) VALUES ($1, $2, $3, $4, $5, 'valid')`,
      [ticketId, eventId, orderId, seatId, 'a'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO ticket_scans (event_id, ticket_id, gate, scanned_by) VALUES ($1, $2, 'Grind A', 'staff')`,
      [eventId, ticketId],
    );
    await pool.query(
      `INSERT INTO waitlist (event_id, contact) VALUES ($1, 'a@example.test')`,
      [eventId],
    );
    return eventId;
  }

  async function countRows(eventId: string): Promise<number> {
    const pool = infra.shardPools.pools[0];
    const queries = [
      'SELECT COUNT(*) AS count FROM events WHERE id = $1',
      ...TABLES.map((table) => `SELECT COUNT(*) AS count FROM ${table} WHERE event_id = $1`),
    ];
    let total = 0;
    for (const sql of queries) {
      const { rows } = await pool.query<{ count: string }>(sql, [eventId]);
      total += Number(rows[0]?.count);
    }
    return total;
  }

  function exportPathFor(eventId: string): string {
    const path = join(tmpdir(), `demo-export-${eventId}.json`);
    files.push(path);
    return path;
  }

  it('torrkörningen skriver ingenting', async () => {
    const eventId = await seedEvent({ orderStatus: 'cancelled' });
    const before = await countRows(eventId);

    const [plan] = await planRemoval(infra.shardPools, [eventId]);

    expect(plan?.exists).toBe(true);
    expect(plan?.rows['seats']).toHaveLength(1);
    expect(await countRows(eventId)).toBe(before);
  }, 60_000);

  it.each([
    ['en betald order', { orderStatus: 'paid' as const }],
    ['en väntande order (öppen Stripe Checkout)', { orderStatus: 'pending' as const }],
    [
      'en aktiv reservation',
      { orderStatus: 'cancelled' as const, reservationStatus: 'active' as const },
    ],
  ])(
    'vägrar och raderar ingenting vid %s',
    async (_label, options) => {
      const eventId = await seedEvent(options);
      const before = await countRows(eventId);

      await expect(applyRemoval(infra.shardPools, [eventId], exportPathFor)).rejects.toThrow(
        /Vägrar/,
      );

      expect(await countRows(eventId)).toBe(before);
      expect(existsSync(exportPathFor(eventId))).toBe(false);
    },
    60_000,
  );

  it('exporterar (0600) och raderar eventet och alla dess rader, men inte andra event', async () => {
    const eventId = await seedEvent({ orderStatus: 'cancelled' });
    const otherEventId = await seedEvent({ orderStatus: 'paid' });
    const otherBefore = await countRows(otherEventId);

    const removed = await applyRemoval(infra.shardPools, [eventId], exportPathFor);

    expect(removed).toEqual([eventId]);
    const path = exportPathFor(eventId);
    const exported = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown[]>;
    for (const table of ['events', ...TABLES]) {
      expect(exported[table], table).toHaveLength(1);
    }
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await countRows(eventId)).toBe(0);
    expect(await countRows(otherEventId)).toBe(otherBefore);
  }, 60_000);

  it('hoppar över ett event som inte finns och går att köra om', async () => {
    const eventId = randomUUID();
    const removed = await applyRemoval(infra.shardPools, [eventId], exportPathFor);
    expect(removed).toEqual([]);
    expect(existsSync(exportPathFor(eventId))).toBe(false);
  }, 60_000);

  it('rullar tillbaka om exporten inte kan skrivas', async () => {
    const eventId = await seedEvent({ orderStatus: 'cancelled' });
    const before = await countRows(eventId);

    await expect(
      applyRemoval(infra.shardPools, [eventId], () => join(tmpdir(), 'finns-inte', 'x.json')),
    ).rejects.toThrow();

    expect(await countRows(eventId)).toBe(before);
  }, 60_000);
});
