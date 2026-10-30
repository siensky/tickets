/**
 * Invarianter över alla events som systemtesterna har skapat (titel med
 * prefixet SYSTEMTEST). Oberoende av körordning: de håller oavsett vilka
 * flöden som hunnit köras (docs/plan.md 7.14).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { SYSTEM_TEST_TITLE_PREFIX, closePools, queryBothShards } from '../helpers/db.js';

afterAll(closePools);

const OWN_EVENTS = `(SELECT id FROM events WHERE title LIKE '${SYSTEM_TEST_TITLE_PREFIX} %')`;

describe('invarianter', () => {
  it('har aldrig fler giltiga biljetter än stolar per event', async () => {
    const rows = await queryBothShards<{ event_id: string }>(
      `SELECT t.event_id FROM tickets t
       WHERE t.status = 'valid' AND t.event_id IN ${OWN_EVENTS}
       GROUP BY t.event_id
       HAVING COUNT(*) > (SELECT COUNT(*) FROM seats s WHERE s.event_id = t.event_id)`,
      [],
    );
    expect(rows).toEqual([]);
  });

  it('har aldrig samma biljettnummer i mer än en giltig biljett', async () => {
    const rows = await queryBothShards<{ ticket_number: string }>(
      `SELECT s.ticket_number FROM tickets t
       JOIN seats s ON s.id = t.seat_id AND s.event_id = t.event_id
       WHERE t.status = 'valid' AND t.event_id IN ${OWN_EVENTS}
       GROUP BY s.ticket_number HAVING COUNT(*) > 1`,
      [],
    );
    expect(rows).toEqual([]);
  });

  it('har lika många giltiga biljetter som reserverade stolar i varje betald order', async () => {
    const rows = await queryBothShards<{ id: string }>(
      `SELECT o.id FROM orders o
       WHERE o.status = 'paid' AND o.event_id IN ${OWN_EVENTS}
         AND (SELECT COUNT(*) FROM tickets t
              WHERE t.event_id = o.event_id AND t.order_id = o.id AND t.status = 'valid')
          <> (SELECT COUNT(*) FROM seats s
              WHERE s.event_id = o.event_id AND s.reservation_id = o.reservation_id)`,
      [],
    );
    expect(rows).toEqual([]);
  });

  it('har ingen såld stol utan en giltig biljett', async () => {
    const rows = await queryBothShards<{ id: string }>(
      `SELECT s.id FROM seats s
       WHERE s.status = 'sold' AND s.event_id IN ${OWN_EVENTS}
         AND NOT EXISTS (SELECT 1 FROM tickets t
                         WHERE t.event_id = s.event_id AND t.seat_id = s.id AND t.status = 'valid')`,
      [],
    );
    expect(rows).toEqual([]);
  });
});
