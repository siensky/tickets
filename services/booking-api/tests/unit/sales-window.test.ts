import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createReadCache } from '../../src/services/read-cache.js';
import {
  readSalesWindow,
  toSalesWindow,
  type TimedSalesWindowSnapshot,
} from '../../src/services/sales-window.js';

const OPEN = new Date('2030-01-01T10:00:00.000Z');
const CLOSE = new Date('2030-01-01T10:15:00.000Z');

function snapshotAt(dbNow: string) {
  return { salesOpenAt: OPEN, salesCloseAt: CLOSE, dbNow: new Date(dbNow) };
}

describe('toSalesWindow', () => {
  it('är stängt före öppning och räknar sekunderna till stängning', () => {
    expect(toSalesWindow(snapshotAt('2030-01-01T09:59:59.000Z'), 0)).toMatchObject({
      isBeforeOpen: true,
      isAfterClose: false,
      secondsUntilClose: 901,
    });
  });

  it('är öppet exakt vid öppning och avrundar kvarvarande sekunder uppåt', () => {
    expect(toSalesWindow(snapshotAt('2030-01-01T10:00:00.000Z'), 500)).toMatchObject({
      isBeforeOpen: false,
      isAfterClose: false,
      secondsUntilClose: 900,
    });
  });

  it('räknar vidare från Postgres-tiden med den tid som gått sedan läsningen', () => {
    const snapshot = snapshotAt('2030-01-01T10:14:59.000Z');

    expect(toSalesWindow(snapshot, 0).isAfterClose).toBe(false);
    expect(toSalesWindow(snapshot, 1000).isAfterClose).toBe(false);
    expect(toSalesWindow(snapshot, 1001)).toMatchObject({
      isAfterClose: true,
      secondsUntilClose: 0,
    });
  });

  it('låter aldrig en negativ förfluten tid flytta tiden bakåt', () => {
    expect(toSalesWindow(snapshotAt('2030-01-01T10:15:00.001Z'), -5000).isAfterClose).toBe(
      true,
    );
  });
});

describe('readSalesWindow', () => {
  function poolReturning(dbNow: string): { pool: Pool; query: ReturnType<typeof vi.fn> } {
    const query = vi.fn().mockResolvedValue({
      rows: [{ sales_open_at: OPEN, sales_close_at: CLOSE, db_now: new Date(dbNow) }],
    });
    return { pool: { query } as unknown as Pool, query };
  }

  it('läser databasen en gång inom cachetiden och räknar ändå fram rätt läge vid kanten', async () => {
    let nowMs = 0;
    const now = () => nowMs;
    const cache = createReadCache<TimedSalesWindowSnapshot>(2000, now);
    const { pool, query } = poolReturning('2030-01-01T10:14:59.500Z');

    expect((await readSalesWindow(pool, 'e1', cache, now)).isAfterClose).toBe(false);
    nowMs = 600;
    expect((await readSalesWindow(pool, 'e1', cache, now)).isAfterClose).toBe(true);
    expect(query).toHaveBeenCalledOnce();
  });

  it('läser databasen varje gång utan cache', async () => {
    const { pool, query } = poolReturning('2030-01-01T10:05:00.000Z');

    await readSalesWindow(pool, 'e1', undefined);
    await readSalesWindow(pool, 'e1', undefined);

    expect(query).toHaveBeenCalledTimes(2);
  });
});
