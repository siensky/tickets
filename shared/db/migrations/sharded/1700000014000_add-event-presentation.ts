/**
 * Eventets presentationsfält (docs/plan.md 7.13 E1): bild, beskrivning och
 * "featured" till startsidans hero. Alla additiva (nullable eller med
 * default), så en migration som körs före ny kod aldrig bryter gammal kod
 * (docs/rules.md §4). `image_url` är en RELATIV nyckel (`images/x.webp`);
 * mappern bygger den absoluta URL:en från `PUBLIC_ASSET_BASE_URL`.
 *
 * Indexet på `seats (event_id, status)` bär tillgänglighetsaggregatet i
 * GET /events (antal lediga stolar per event).
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.addColumns('events', {
    image_url: { type: 'text' },
    description: { type: 'text' },
    featured: { type: 'boolean', notNull: true, default: false },
  });
  pgm.createIndex('seats', ['event_id', 'status']);
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropIndex('seats', ['event_id', 'status']);
  pgm.dropColumns('events', ['image_url', 'description', 'featured']);
}
