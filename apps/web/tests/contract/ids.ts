/**
 * Fasta id:n delade av konsumentkontraktet (web → booking-api) och de
 * provider-states booking-api seedar för dem. Giltiga v4-UUID:er, eftersom
 * routerna validerar med Zod `.uuid()`.
 */
export const EVENT_ID = '11111111-1111-4111-8111-111111111111';
export const VENUE_ID = '22222222-2222-4222-8222-222222222222';
export const SECTION_ID = '33333333-3333-4333-8333-333333333333';
export const SEAT_ID = '44444444-4444-4444-8444-444444444444';
export const RESERVATION_ID = '55555555-5555-4555-8555-555555555555';
export const ORDER_ID = '66666666-6666-4666-8666-666666666666';
export const UNKNOWN_ORDER_ID = '77777777-7777-4777-8777-777777777777';
