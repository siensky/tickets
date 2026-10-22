import { describe, expect, it } from 'vitest';
import { eventIdParamSchema } from '../event-id-param.js';

describe('eventIdParamSchema', () => {
  it('accepts a valid UUID', () => {
    const result = eventIdParamSchema.safeParse({
      eventId: '123e4567-e89b-12d3-a456-426614174000',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-UUID string', () => {
    const result = eventIdParamSchema.safeParse({ eventId: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown extra field (strict mode)', () => {
    const result = eventIdParamSchema.safeParse({
      eventId: '123e4567-e89b-12d3-a456-426614174000',
      admin: true,
    });
    expect(result.success).toBe(false);
  });
});
