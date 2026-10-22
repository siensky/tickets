/**
 * Request body för att skapa en reservation (docs/plan.md
 * "Concurrency-kärnan"). Delas med frontend (docs/forsvar.md "ett schema,
 * tre användningar") — samma gräns (1–5 stolar) som
 * `max_seats_per_reservation` i config-tabellen beskriver, men den
 * SKARPA gränsen sätts fortfarande av config-värdet på servern
 * (docs/rules.md §6: "Priser beräknas alltid på servern"; samma princip
 * gäller antal — klientens validering är bara UX, aldrig sanningen).
 */
import { z } from 'zod';

export const createReservationRequestSchema = z
  .object({
    seatIds: z.array(z.string().uuid()).min(1).max(5),
  })
  .strict();

export type CreateReservationRequest = z.infer<typeof createReservationRequestSchema>;
