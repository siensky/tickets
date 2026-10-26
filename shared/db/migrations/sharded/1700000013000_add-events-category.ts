/**
 * `events.category` (Fas 6, docs/plan.md: navbarens kategorier — musik,
 * sport, teater, festival). `NOT NULL` med `DEFAULT 'music'` — framåt-
 * kompatibel enligt docs/rules.md §4 (migrationen kör innan ny kod
 * deployas): det enda CSV-importerade eventet som redan finns är en
 * konsert, så defaulten råkar redan vara korrekt för det, men även om
 * den inte vore det är en NOT NULL-kolumn med en konkret default alltid
 * säkrare än en nullable en — "kategori saknas" hade annars varit ett
 * tredje, odokumenterat tillstånd `GET /events?category=...`-filtret
 * måste ta ställning till.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.addColumn('events', {
    category: {
      type: 'text',
      notNull: true,
      default: 'music',
      check: "category IN ('music', 'sports', 'theatre', 'festival')",
    },
  });
  // Fritextsöket (titel/artist) och kategorifiltret är de två vägarna
  // in i GET /events — ett index på category ensamt räcker inte för
  // sökningen (ILIKE/trigram är ett större steg, inte motiverat för en
  // handfull demo-event), men ett enkelt index håller kategorifiltret
  // snabbt oavsett hur mycket seed-data som läggs till.
  pgm.createIndex('events', 'category');
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropIndex('events', 'category');
  pgm.dropColumn('events', 'category');
}
