/**
 * Arenakartans layout (docs/plan.md 7.13 E2). Sektionernas placering och
 * scenens position i ett abstrakt koordinatsystem, en ruta på 0–1000 ×
 * 0–700 (SVG-viewBox). Alla kolumner är nullable (rotationen har default
 * 0): en venue utan layout, t.ex. lasttestarenan, ger `layout: null` i
 * API:t och UI:t faller tillbaka på kortrutnätet.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.addColumns('venue_sections', {
    layout_x: { type: 'numeric' },
    layout_y: { type: 'numeric' },
    layout_width: { type: 'numeric' },
    layout_height: { type: 'numeric' },
    layout_rotation: { type: 'numeric', notNull: true, default: 0 },
  });
  pgm.addColumns('venues', {
    stage_x: { type: 'numeric' },
    stage_y: { type: 'numeric' },
    stage_width: { type: 'numeric' },
    stage_height: { type: 'numeric' },
  });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropColumns('venues', ['stage_x', 'stage_y', 'stage_width', 'stage_height']);
  pgm.dropColumns('venue_sections', [
    'layout_x',
    'layout_y',
    'layout_width',
    'layout_height',
    'layout_rotation',
  ]);
}
