/**
 * Hur länge en väntande besökare ska vänta till nästa statusfråga (docs/plan.md "Väntrum"). Servern
 * bestämmer, inte klienten: med en fast takt (varannan sekund utan WebSocket) blev väntan i kön den
 * dyraste delen av spike-testet 7/11 (~215 000 statusanrop på 10 minuter), och ju sämre systemet mådde
 * desto fler sockets föll bort och desto tätare pollades det.
 *
 * Intervallet är en fjärdedel av den beräknade väntan, inom 5–30 s: den som står långt bak frågar
 * sällan, den som snart är framme ofta nog att märka insläppet. Insläppet kommer i första hand via
 * WebSocket; pollningen är reserven.
 */
export const MIN_POLL_SECONDS = 5;
export const MAX_POLL_SECONDS = 30;

export function nextPollSeconds(position: number, admissionRatePerMinute: number): number {
  if (admissionRatePerMinute <= 0) {
    return MAX_POLL_SECONDS;
  }
  const secondsUntilTurn = position / (admissionRatePerMinute / 60);
  return Math.min(
    MAX_POLL_SECONDS,
    Math.max(MIN_POLL_SECONDS, Math.round(secondsUntilTurn / 4)),
  );
}
