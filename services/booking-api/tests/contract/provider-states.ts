/**
 * Provider-states för Pact-verifieringen av booking-api (docs/plan.md 7.9).
 * Varje state nollställer databasen och Redis, seedar sedan exakt det
 * kontraktet beskriver, med SQL mot en riktig Postgres (docs/rules.md §8).
 * Id:n kommer från konsumenternas fasta fixturer.
 */
import { randomUUID } from 'node:crypto';
import { issueQueueToken } from '@tickets/auth';
import { admitNextBatch, joinWaitingRoom, type RedisClient } from '@tickets/redis';
import type { Pool } from 'pg';

// Samma id:n som apps/web/tests/contract/ids.ts.
export const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const VENUE_ID = '22222222-2222-4222-8222-222222222222';
const SECTION_ID = '33333333-3333-4333-8333-333333333333';
const SEAT_ID = '44444444-4444-4444-8444-444444444444';
const RESERVATION_ID = '55555555-5555-4555-8555-555555555555';
const ORDER_ID = '66666666-6666-4666-8666-666666666666';
// Samma id:n som webhook-kontraktet i services/payment-mock/tests/contract.
const WEBHOOK_ORDER_ID = '5b0f1a9e-3c6d-4f7a-8d2e-1a2b3c4d5e6f';
const WEBHOOK_EVENT_ID = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const WEBHOOK_RESERVATION_ID = '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a';
const WEBHOOK_SESSION_ID = 'cs_mock_contract';

export const USER_SUB = 'auth0|contract-user';
const SEAT_PRICE_CENTS = 39_500;

export interface StateContext {
  readonly pool: Pool;
  readonly redis: RedisClient;
  readonly queueTokenSecret: Uint8Array;
  /** Det kötoken som `requestFilter` sätter på inkommande anrop. */
  currentQueueToken: string | undefined;
}

async function reset(ctx: StateContext): Promise<void> {
  await ctx.pool.query(
    `TRUNCATE tickets, payments, orders, outbox, processed_messages, idempotency_keys,
              reservations, seats, events, venues, venue_sections, venue_seats, users CASCADE`,
  );
  await ctx.redis.flushdb();
  ctx.currentQueueToken = undefined;
}

async function seedVenue(pool: Pool, withLayout: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO venues (id, name, city) VALUES ($1, 'Systemtestarenan', 'Testby')`,
    [VENUE_ID],
  );
  await pool.query(
    `INSERT INTO venue_sections (id, venue_id, name, display_order) VALUES ($1, $2, 'Parkett', 1)`,
    [SECTION_ID, VENUE_ID],
  );
  if (withLayout) {
    await pool.query(
      `UPDATE venue_sections SET layout_x = 100, layout_y = 200, layout_width = 300,
              layout_height = 150, layout_rotation = 0 WHERE id = $1`,
      [SECTION_ID],
    );
    await pool.query(
      `UPDATE venues SET stage_x = 350, stage_y = 20, stage_width = 300, stage_height = 60
       WHERE id = $1`,
      [VENUE_ID],
    );
  }
}

async function seedEvent(
  pool: Pool,
  options: { withImage: boolean; seatStatus?: string },
): Promise<void> {
  await seedVenue(pool, true);
  await pool.query(
    `INSERT INTO events (id, venue_id, title, artist, starts_at, sales_open_at, sales_close_at,
                         image_url, description, featured)
     VALUES ($1, $2, 'Neon Rivers', 'Neon Rivers', now() + interval '7 days',
             now() - interval '1 day', now() + interval '6 days', $3, $4, $5)`,
    [
      EVENT_ID,
      VENUE_ID,
      options.withImage ? 'images/neon.webp' : null,
      options.withImage ? 'Beskrivning' : null,
      options.withImage,
    ],
  );
  await pool.query(
    `INSERT INTO seats (id, event_id, venue_seat_id, section_id, row, number, ticket_number,
                        price_cents, status)
     VALUES ($1, $2, $3, $4, 'A', 1, 'T-1', $5, $6)`,
    [
      SEAT_ID,
      EVENT_ID,
      randomUUID(),
      SECTION_ID,
      SEAT_PRICE_CENTS,
      options.seatStatus ?? 'available',
    ],
  );
}

async function issueAdmittedQueueToken(ctx: StateContext): Promise<string> {
  const issued = await issueQueueToken(ctx.queueTokenSecret, EVENT_ID, 3600);
  await joinWaitingRoom(ctx.redis, EVENT_ID, issued.queueTokenId);
  await admitNextBatch(ctx.redis, EVENT_ID, 10, 600, 15);
  ctx.currentQueueToken = issued.token;
  return issued.queueTokenId;
}

async function seedActiveReservation(ctx: StateContext): Promise<void> {
  await seedEvent(ctx.pool, { withImage: true, seatStatus: 'held' });
  const queueTokenId = await issueAdmittedQueueToken(ctx);
  await ctx.pool.query(
    `INSERT INTO reservations (id, event_id, queue_token_id, status, expires_at, release_after)
     VALUES ($1, $2, $3, 'active', now() + interval '5 minutes', now() + interval '6 minutes')`,
    [RESERVATION_ID, EVENT_ID, queueTokenId],
  );
  await ctx.pool.query('UPDATE seats SET reservation_id = $1 WHERE id = $2', [
    RESERVATION_ID,
    SEAT_ID,
  ]);
}

async function seedPaidOrder(ctx: StateContext): Promise<void> {
  const userId = randomUUID();
  await seedEvent(ctx.pool, { withImage: true, seatStatus: 'sold' });
  await ctx.pool.query(
    `INSERT INTO users (id, auth0_sub, email, name) VALUES ($1, $2, 'buyer@example.test', 'Buyer')`,
    [userId, USER_SUB],
  );
  await ctx.pool.query(
    `INSERT INTO orders (id, event_id, user_id, total_cents, status) VALUES ($1, $2, $3, $4, 'paid')`,
    [ORDER_ID, EVENT_ID, userId, SEAT_PRICE_CENTS],
  );
  await ctx.pool.query(
    `INSERT INTO tickets (event_id, order_id, seat_id, qr_token, status)
     VALUES ($1, $2, $3, 'qr-token', 'valid')`,
    [EVENT_ID, ORDER_ID, SEAT_ID],
  );
}

async function seedPendingWebhookPayment(ctx: StateContext): Promise<void> {
  const userId = randomUUID();
  await ctx.pool.query(
    `INSERT INTO events (id, venue_id, title, artist, starts_at, sales_open_at, sales_close_at)
     VALUES ($1, gen_random_uuid(), 'Webhook', 'Webhook', now() + interval '7 days',
             now() - interval '1 day', now() + interval '6 days')`,
    [WEBHOOK_EVENT_ID],
  );
  await ctx.pool.query(
    `INSERT INTO users (id, auth0_sub, email, name) VALUES ($1, 'auth0|webhook', 'w@example.test', 'W')`,
    [userId],
  );
  await ctx.pool.query(
    `INSERT INTO orders (id, event_id, user_id, reservation_id, total_cents, status)
     VALUES ($1, $2, $3, $4, 109000, 'pending')`,
    [WEBHOOK_ORDER_ID, WEBHOOK_EVENT_ID, userId, WEBHOOK_RESERVATION_ID],
  );
  await ctx.pool.query(
    `INSERT INTO payments (event_id, order_id, provider, provider_ref, idempotency_key,
                           amount_cents, status)
     VALUES ($1, $2, 'stripe', $3, 'idem-webhook', 109000, 'pending')`,
    [WEBHOOK_EVENT_ID, WEBHOOK_ORDER_ID, WEBHOOK_SESSION_ID],
  );
}

export function createStateHandlers(ctx: StateContext): Record<string, () => Promise<void>> {
  const withReset =
    (seed: () => Promise<void>): (() => Promise<void>) =>
    async () => {
      await reset(ctx);
      await seed();
    };
  return {
    'an event with an image exists': withReset(() => seedEvent(ctx.pool, { withImage: true })),
    'an event without an image exists': withReset(() =>
      seedEvent(ctx.pool, { withImage: false }),
    ),
    'no event exists': withReset(() => Promise.resolve()),
    'an event with a laid-out section exists': withReset(() =>
      seedEvent(ctx.pool, { withImage: true }),
    ),
    'an event with an available seat exists': withReset(() =>
      seedEvent(ctx.pool, { withImage: true }),
    ),
    'the queue token is admitted and the seat is available': withReset(async () => {
      await seedEvent(ctx.pool, { withImage: true });
      await issueAdmittedQueueToken(ctx);
    }),
    'an active reservation with one seat exists': withReset(() => seedActiveReservation(ctx)),
    'a paid order with one ticket exists for the user': withReset(() => seedPaidOrder(ctx)),
    'a pending payment exists for the checkout session': withReset(() =>
      seedPendingWebhookPayment(ctx),
    ),
  };
}
