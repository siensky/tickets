import { createQueueTokenSecret, issueQueueToken } from '@tickets/auth';
import type { Logger } from '@tickets/observability';
import type { RedisClient } from '@tickets/redis';
import { describe, expect, it, vi } from 'vitest';
import { authenticateQueueToken } from '../../src/services/queue-auth-service.js';

const SECRET = createQueueTokenSecret('unit-test-secret-at-least-32-bytes!!');
const SILENT_LOGGER = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

function fakeRedis(existsResult: number): {
  redis: RedisClient;
  exists: ReturnType<typeof vi.fn>;
} {
  const exists = vi.fn().mockResolvedValue(existsResult);
  return { redis: { exists } as unknown as RedisClient, exists };
}

describe('authenticateQueueToken', () => {
  it('accepts a signed, non-revoked token', async () => {
    const issued = await issueQueueToken(SECRET, 'event-1', 900);
    const { redis } = fakeRedis(0);

    const result = await authenticateQueueToken(
      { redis, queueTokenSecret: SECRET, logger: SILENT_LOGGER },
      issued.token,
    );

    expect(result).toEqual({
      kind: 'valid',
      queueTokenId: issued.queueTokenId,
      eventId: 'event-1',
    });
  });

  it('rejects a token that has been revoked even though the signature is valid', async () => {
    const issued = await issueQueueToken(SECRET, 'event-1', 900);
    const { redis } = fakeRedis(1);

    const result = await authenticateQueueToken(
      { redis, queueTokenSecret: SECRET, logger: SILENT_LOGGER },
      issued.token,
    );

    expect(result.kind).toBe('invalid');
  });

  it('rejects a malformed token without ever checking revocation', async () => {
    const { redis, exists } = fakeRedis(0);

    const result = await authenticateQueueToken(
      { redis, queueTokenSecret: SECRET, logger: SILENT_LOGGER },
      'garbage',
    );

    expect(result.kind).toBe('invalid');
    expect(exists).not.toHaveBeenCalled();
  });

  it('fails open (treats the token as valid) when the revocation check is unreachable', async () => {
    const issued = await issueQueueToken(SECRET, 'event-1', 900);
    const redis = {
      exists: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as unknown as RedisClient;

    const result = await authenticateQueueToken(
      { redis, queueTokenSecret: SECRET, logger: SILENT_LOGGER },
      issued.token,
    );

    expect(result).toEqual({
      kind: 'valid',
      queueTokenId: issued.queueTokenId,
      eventId: 'event-1',
    });
  });
});
