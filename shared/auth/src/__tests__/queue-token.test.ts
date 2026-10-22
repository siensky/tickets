import { describe, expect, it } from 'vitest';
import { createQueueTokenSecret, issueQueueToken, verifyQueueToken } from '../queue-token.js';

const SECRET = createQueueTokenSecret('test-secret-at-least-32-bytes-long!!');

describe('issueQueueToken + verifyQueueToken', () => {
  it('verifies a token it just issued and returns the same queueTokenId and eventId', async () => {
    const issued = await issueQueueToken(SECRET, 'event-1', 900);
    const result = await verifyQueueToken(SECRET, issued.token);

    expect(result).toEqual({
      kind: 'valid',
      queueTokenId: issued.queueTokenId,
      eventId: 'event-1',
    });
  });

  it('issues a fresh, unique queueTokenId on every call', async () => {
    const a = await issueQueueToken(SECRET, 'event-1', 900);
    const b = await issueQueueToken(SECRET, 'event-1', 900);
    expect(a.queueTokenId).not.toBe(b.queueTokenId);
  });

  it('rejects a token signed with a different secret', async () => {
    const otherSecret = createQueueTokenSecret('a-completely-different-secret-value');
    const issued = await issueQueueToken(otherSecret, 'event-1', 900);
    const result = await verifyQueueToken(SECRET, issued.token);
    expect(result.kind).toBe('invalid');
  });

  it('rejects a token whose exp has already passed', async () => {
    const issued = await issueQueueToken(SECRET, 'event-1', -1);
    const result = await verifyQueueToken(SECRET, issued.token);
    expect(result.kind).toBe('invalid');
  });

  it('rejects garbage input instead of throwing', async () => {
    const result = await verifyQueueToken(SECRET, 'not-a-jwt');
    expect(result.kind).toBe('invalid');
  });
});
