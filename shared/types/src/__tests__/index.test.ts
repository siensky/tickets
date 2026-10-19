import { describe, expectTypeOf, it } from 'vitest';
import type { EventId, SeatId } from '../index.js';

describe('@tickets/types branded types', () => {
  it('EventId and SeatId are structurally strings but nominally distinct', () => {
    const eventId = 'event-1' as EventId;
    expectTypeOf(eventId).toMatchTypeOf<string>();
    expectTypeOf<EventId>().not.toEqualTypeOf<SeatId>();
  });
});
