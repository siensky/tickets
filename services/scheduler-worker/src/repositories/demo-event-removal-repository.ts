/**
 * All SQL för `scripts/remove-demo-events.ts` (docs/plan.md 8.3, docs/rules.md §4). Tar en redan uttagen
 * `PoolClient` så att `BEGIN`/`COMMIT` körs på samma anslutning. Varje fråga bär `event_id`. `outbox`,
 * `processed_messages` och `idempotency_keys` lämnas orörda: de har egen retention.
 */
import type { PoolClient } from 'pg';

/** Tabellerna som exporteras och töms för ett event, i en ordning som respekterar främmande nycklar. */
const EVENT_TABLES = [
  'ticket_scans',
  'tickets',
  'payments',
  'orders',
  'reservations',
  'waitlist',
  'seats',
] as const;

export type EventExport = Readonly<Record<string, readonly unknown[]>>;

export class BlockedRemovalError extends Error {
  constructor(
    readonly eventId: string,
    readonly blockingRows: number,
  ) {
    super(
      `Vägrar: ${String(blockingRows)} betalda eller pågående ordrar/reservationer på ${eventId}. Inget har raderats.`,
    );
    this.name = 'BlockedRemovalError';
  }
}

export async function exportEventRows(
  client: PoolClient,
  eventId: string,
): Promise<EventExport> {
  const exported: Record<string, readonly unknown[]> = {};
  const events = await client.query('SELECT * FROM events WHERE id = $1', [eventId]);
  exported['events'] = events.rows;
  for (const table of EVENT_TABLES) {
    // Tabellnamnet kommer ur den fasta listan ovan, aldrig från indata.
    const result = await client.query(`SELECT * FROM ${table} WHERE event_id = $1`, [eventId]);
    exported[table] = result.rows;
  }
  return exported;
}

/**
 * Rader som betyder att någon har betalat eller är på väg att betala: betalda eller väntande ordrar och
 * aktiva eller betalande reservationer. En väntande order kan ha en öppen Stripe Checkout; raderas den
 * landar betalningen på en order som saknas och kunden får varken biljett eller återbetalning.
 */
export async function countBlockingRows(client: PoolClient, eventId: string): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT
       (SELECT COUNT(*) FROM orders WHERE event_id = $1 AND status IN ('paid', 'pending'))
       + (SELECT COUNT(*) FROM reservations
          WHERE event_id = $1 AND status IN ('active', 'pending_payment')) AS count`,
    [eventId],
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Kontroll, export och radering i SAMMA transaktion, med eventraden låst: en order som blir betald under
 * tiden kan inte slinka förbi, och allt som raderas är också exporterat. `writeExport` anropas före första
 * DELETE; kastar den (t.ex. disken full) rullas allt tillbaka.
 */
export async function removeEvent(
  client: PoolClient,
  eventId: string,
  writeExport: (rows: EventExport) => void,
): Promise<Record<string, number> | undefined> {
  await client.query('BEGIN');
  try {
    const locked = await client.query('SELECT id FROM events WHERE id = $1 FOR UPDATE', [
      eventId,
    ]);
    const rows = await exportEventRows(client, eventId);
    const hasAnyRows =
      (locked.rowCount ?? 0) > 0 || Object.values(rows).some((r) => r.length > 0);
    if (!hasAnyRows) {
      await client.query('ROLLBACK');
      return undefined;
    }
    const blocking = await countBlockingRows(client, eventId);
    if (blocking > 0) {
      throw new BlockedRemovalError(eventId, blocking);
    }
    writeExport(rows);
    const deleted: Record<string, number> = {};
    for (const table of EVENT_TABLES) {
      const result = await client.query(`DELETE FROM ${table} WHERE event_id = $1`, [eventId]);
      deleted[table] = result.rowCount ?? 0;
    }
    const events = await client.query('DELETE FROM events WHERE id = $1', [eventId]);
    deleted['events'] = events.rowCount ?? 0;
    await client.query('COMMIT');
    return deleted;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
