import { describe, expect, it } from 'vitest';
import {
  eventSeatParamSchema,
  eventSectionParamSchema,
  venueIdParamSchema,
  venueSectionParamSchema,
} from '../seatmap-params.js';

const UUID_A = '123e4567-e89b-12d3-a456-426614174000';
const UUID_B = '223e4567-e89b-12d3-a456-426614174001';

describe('venueIdParamSchema', () => {
  it('accepts a valid UUID', () => {
    expect(venueIdParamSchema.safeParse({ venueId: UUID_A }).success).toBe(true);
  });

  it('rejects a non-UUID string', () => {
    expect(venueIdParamSchema.safeParse({ venueId: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('venueSectionParamSchema', () => {
  it('accepts two valid UUIDs', () => {
    expect(
      venueSectionParamSchema.safeParse({ venueId: UUID_A, sectionId: UUID_B }).success,
    ).toBe(true);
  });

  it('rejects an unknown extra field (strict mode)', () => {
    expect(
      venueSectionParamSchema.safeParse({ venueId: UUID_A, sectionId: UUID_B, admin: true })
        .success,
    ).toBe(false);
  });

  it('rejects a missing sectionId', () => {
    expect(venueSectionParamSchema.safeParse({ venueId: UUID_A }).success).toBe(false);
  });
});

describe('eventSectionParamSchema', () => {
  it('accepts two valid UUIDs', () => {
    expect(
      eventSectionParamSchema.safeParse({ eventId: UUID_A, sectionId: UUID_B }).success,
    ).toBe(true);
  });

  it('rejects a non-UUID sectionId', () => {
    expect(
      eventSectionParamSchema.safeParse({ eventId: UUID_A, sectionId: 'nope' }).success,
    ).toBe(false);
  });
});

describe('eventSeatParamSchema', () => {
  it('accepts two valid UUIDs', () => {
    expect(eventSeatParamSchema.safeParse({ eventId: UUID_A, seatId: UUID_B }).success).toBe(
      true,
    );
  });

  it('rejects a non-UUID eventId', () => {
    expect(eventSeatParamSchema.safeParse({ eventId: 'nope', seatId: UUID_B }).success).toBe(
      false,
    );
  });
});
