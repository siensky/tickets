/**
 * Dedupe för pengar/biljetter (docs/plan.md "Idempotens": "Pengar och
 * biljetter: processed_messages-tabell med unique-constraint") — i
 * motsats till notifikationers Redis-set-med-TTL, en durabel databas-
 * rad som aldrig tappas vid en Redis-omstart.
 */
import type { PoolClient } from 'pg';

/** Returnerar `true` om det här är FÖRSTA gången (event, messageId, consumer) ses. */
export async function claimProcessedMessage(
  client: PoolClient,
  params: { eventId: string; messageId: string; consumer: string },
): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO processed_messages (event_id, message_id, consumer)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [params.eventId, params.messageId, params.consumer],
  );
  return rowCount === 1;
}
