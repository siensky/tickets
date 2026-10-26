/**
 * All SQL för business-metrics-service.ts (docs/rules.md §4: "All SQL i
 * repositories/"). Två rena COUNT-frågor, grupperade på `event_id` —
 * en shard kan ha flera events igång samtidigt, även om lasttestet
 * bara använder ett.
 */
import type { Pool } from 'pg';

export interface EventCount {
  readonly eventId: string;
  readonly count: number;
}

function toEventCounts(rows: readonly { event_id: string; count: string }[]): EventCount[] {
  return rows.map((row) => ({ eventId: row.event_id, count: Number(row.count) }));
}

export async function countActiveReservations(pool: Pool): Promise<EventCount[]> {
  const { rows } = await pool.query<{ event_id: string; count: string }>(
    "SELECT event_id, COUNT(*) AS count FROM reservations WHERE status IN ('active', 'pending_payment') GROUP BY event_id",
  );
  return toEventCounts(rows);
}

export async function countSoldTickets(pool: Pool): Promise<EventCount[]> {
  const { rows } = await pool.query<{ event_id: string; count: string }>(
    "SELECT event_id, COUNT(*) AS count FROM tickets WHERE status = 'valid' GROUP BY event_id",
  );
  return toEventCounts(rows);
}
