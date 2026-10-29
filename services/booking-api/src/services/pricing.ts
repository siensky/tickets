/**
 * Summan av stolspriser i öre. En enda funktion för både checkout och
 * reservationsvyn (docs/plan.md 7.13 E5), så summan som visas och summan
 * som debiteras aldrig kan skilja sig. Priserna kommer alltid från
 * databasen, aldrig från klienten (docs/rules.md §6).
 */
export function sumSeatPrices(seats: readonly { readonly priceCents: number }[]): number {
  return seats.reduce((sum, seat) => sum + seat.priceCents, 0);
}
