/**
 * Stolsstatusen i sina tre former (`?view=`, types/seatmap.ts). Alla tre byggs ur samma rader, sorterade
 * på stolens id (seats-repository.ts), så katalogen och den kompakta statusen alltid står i samma ordning.
 *
 * Varför uppdelningen: en sektion med 5 000 stolar gav ett svar på ca 790 KB varannan sekund per besökare,
 * och det var det som fyllde ingress och lastgeneratorernas nätverk i spike-sale. Katalogen (id och pris)
 * ändras inte under en försäljning och hämtas en gång; den kompakta statusen är ett tecken per stol.
 */
import { createHash } from 'node:crypto';
import {
  toCompactSeatStatus,
  toSeatCatalog,
  toSeatStatusEntries,
} from '../mappers/seatmap-mapper.js';
import type { SeatStatusRow, SeatStatusView } from '../types/seatmap.js';

/** Ändras när en stol läggs till eller tas bort i sektionen, annars aldrig. Klienten jämför den mellan svaren. */
export function seatListVersion(rows: readonly SeatStatusRow[]): string {
  const hash = createHash('sha256');
  for (const row of rows) {
    hash.update(row.id).update(',');
  }
  return hash.digest('hex').slice(0, 16);
}

export function toSeatStatusBody(
  rows: readonly SeatStatusRow[],
  view: SeatStatusView,
): string {
  switch (view) {
    case 'full':
      return JSON.stringify({ seats: toSeatStatusEntries(rows) });
    case 'catalog':
      return JSON.stringify(toSeatCatalog(rows, seatListVersion(rows)));
    case 'compact':
      return JSON.stringify(toCompactSeatStatus(rows, seatListVersion(rows)));
  }
}
