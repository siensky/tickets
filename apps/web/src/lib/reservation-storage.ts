/**
 * Vilken reservation DEN HÄR FLIKEN senast skapade, per event (sessionStorage, alltså aldrig delat mellan
 * flikar). Kartan släpper bara den: en annan flik med en egen pågående bokning avbryts då aldrig av misstag,
 * och ett sent avbokningsanrop kan inte träffa en nyare reservation eftersom det gäller ett bestämt id.
 */

function storageKey(eventId: string): string {
  return `tickets:last-reservation:${eventId}`;
}

export function getLastReservationId(eventId: string): string | undefined {
  try {
    return sessionStorage.getItem(storageKey(eventId)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function storeLastReservationId(eventId: string, reservationId: string): void {
  try {
    sessionStorage.setItem(storageKey(eventId), reservationId);
  } catch {
    // Utan lagring ersätter servern ändå den egna reservationen vid nästa reservation.
  }
}

export function clearLastReservationId(eventId: string): void {
  try {
    sessionStorage.removeItem(storageKey(eventId));
  } catch {
    // Inget att städa.
  }
}
