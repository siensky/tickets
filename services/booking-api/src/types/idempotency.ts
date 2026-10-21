/**
 * Shapes for the generic idempotency-key claim/complete flow
 * (docs/plan.md "Idempotens"). Kept separate from reservation.ts since
 * Fas 3's payment flow reuses the same `idempotency_keys` table and
 * repository pattern against a different scope.
 */

export interface IdempotencyClaimParams {
  readonly eventId: string;
  readonly scope: string;
  readonly key: string;
  readonly requestHash: string;
  readonly ttlMs: number;
}

export type IdempotencyClaim =
  | { readonly kind: 'claimed' }
  | {
      readonly kind: 'in_flight';
    }
  | {
      readonly kind: 'hash_mismatch';
    }
  | {
      readonly kind: 'completed';
      readonly responseBody: unknown;
    };
