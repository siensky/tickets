/**
 * Seedar en betald order med en giltig biljett direkt i databasen för scanner-e2e
 * (docs/plan.md 7.8). Köpflödet är redan testat i `booking-flow`; här behövs bara en biljett
 * med känd `qr_token`. `cleanup` tar bort raderna igen så att `seed.ts` kan köras om lokalt
 * (stolarna har främmande nycklar från biljetterna).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { hashEventIdToShardIndex } from '@tickets/db';
import { Pool } from 'pg';

const SHARD_URLS = [
  process.env['DATABASE_URL_SHARD_0'] ??
    'postgresql://postgres:postgres@localhost:5432/tickets',
  process.env['DATABASE_URL_SHARD_1'] ??
    'postgresql://postgres:postgres@localhost:5452/tickets',
];

export interface ScannableTicket {
  readonly qrToken: string;
  readonly userId: string;
}

export async function seedScannableTicket(
  eventId: string,
  seatId: string,
): Promise<ScannableTicket> {
  const pools = SHARD_URLS.map((connectionString) => new Pool({ connectionString }));
  try {
    const eventPool = pools[hashEventIdToShardIndex(eventId, pools.length)];
    const globalPool = pools[0];
    if (eventPool === undefined || globalPool === undefined) {
      throw new Error('Ingen shard för eventet');
    }
    const userId = randomUUID();
    const orderId = randomUUID();
    const qrToken = randomBytes(32).toString('hex');
    await globalPool.query(
      `INSERT INTO users (id, auth0_sub, email, name) VALUES ($1, $2, $3, 'Scanner E2E')`,
      [userId, `auth0|scanner-e2e-${userId}`, `${userId}@example.test`],
    );
    await eventPool.query(
      `INSERT INTO orders (id, event_id, user_id, total_cents, status) VALUES ($1, $2, $3, 1000, 'paid')`,
      [orderId, eventId, userId],
    );
    await eventPool.query(
      `INSERT INTO tickets (event_id, order_id, seat_id, qr_token, status)
       VALUES ($1, $2, $3, $4, 'valid')`,
      [eventId, orderId, seatId, qrToken],
    );
    await eventPool.query(`UPDATE seats SET status = 'sold' WHERE id = $1`, [seatId]);
    return { qrToken, userId };
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
  }
}

export async function cleanupScannableTickets(eventId: string, userId: string): Promise<void> {
  const pools = SHARD_URLS.map((connectionString) => new Pool({ connectionString }));
  try {
    const eventPool = pools[hashEventIdToShardIndex(eventId, pools.length)];
    await eventPool?.query('DELETE FROM ticket_scans WHERE event_id = $1', [eventId]);
    await eventPool?.query('DELETE FROM tickets WHERE event_id = $1', [eventId]);
    await eventPool?.query('DELETE FROM orders WHERE event_id = $1', [eventId]);
    await pools[0]?.query('DELETE FROM users WHERE id = $1', [userId]);
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
  }
}
