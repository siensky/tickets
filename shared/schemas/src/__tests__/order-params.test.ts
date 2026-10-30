import { describe, expect, it } from 'vitest';
import { eventOrderParamSchema } from '../order-params.js';

const UUID_A = '123e4567-e89b-12d3-a456-426614174000';
const UUID_B = '223e4567-e89b-12d3-a456-426614174000';

describe('eventOrderParamSchema', () => {
  it('accepts a valid eventId and orderId', () => {
    expect(eventOrderParamSchema.safeParse({ eventId: UUID_A, orderId: UUID_B }).success).toBe(
      true,
    );
  });

  it('accepts a hash-derived orderId without RFC 4122 version bits', () => {
    const derived = '1e3de012-5bc3-db83-35ab-6dc932305f15';
    expect(
      eventOrderParamSchema.safeParse({ eventId: UUID_A, orderId: derived }).success,
    ).toBe(true);
  });

  it('rejects a non-UUID orderId', () => {
    expect(eventOrderParamSchema.safeParse({ eventId: UUID_A, orderId: 'nope' }).success).toBe(
      false,
    );
  });
});
