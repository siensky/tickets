import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { withTransaction } from '../transaction.js';

function createFakeClient(): {
  client: PoolClient;
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn().mockResolvedValue(undefined);
  const release = vi.fn();
  // Only `query`/`release` are exercised by withTransaction — cast
  // narrows a minimal fake up to the full PoolClient shape so the test
  // doesn't have to stub pg internals nothing here calls. The mocks are
  // returned separately so assertions never read a method back off the
  // typed `client` (that's what @typescript-eslint/unbound-method warns
  // about — reading `client.query` as a value, even just to assert on
  // it, looks like an unbound method reference).
  const client = { query, release } as unknown as PoolClient;
  return { client, query, release };
}

describe('withTransaction', () => {
  it('runs BEGIN, the callback, then COMMIT, and releases the client back to the pool', async () => {
    const { client, query, release } = createFakeClient();
    const pool = { connect: vi.fn().mockResolvedValue(client) };

    const result = await withTransaction(pool, (c) => {
      expect(c).toBe(client);
      return Promise.resolve('ok');
    });

    expect(result).toBe('ok');
    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenNthCalledWith(2, 'COMMIT');
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(false);
  });

  it('rolls back, rethrows the original error, and destroys the connection, when the callback fails', async () => {
    const { client, query, release } = createFakeClient();
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const failure = new Error('boom');

    await expect(
      withTransaction(pool, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenNthCalledWith(2, 'ROLLBACK');
    // true, not an Error object: tells node-postgres to destroy this
    // connection instead of recycling a possibly-poisoned one.
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(true);
  });

  it('still rethrows the ORIGINAL error, and still destroys the connection, when ROLLBACK itself fails', async () => {
    const { client, query, release } = createFakeClient();
    // 1st call is BEGIN (resolves), 2nd is the ROLLBACK withTransaction
    // issues after the callback throws (rejects here).
    query
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('connection already closed'));
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const failure = new Error('original failure');

    await expect(
      withTransaction(pool, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(true);
  });
});
