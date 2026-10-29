/**
 * `venues.csv` → planerade arenor, sektioner och stolar (docs/plan.md 7.6, 7.13 E3).
 * Stolarnas `x/y` är sektionens lokala rutnät (rad × plats), som `SeatGrid`
 * redan förväntar sig. Alla id:n härleds ur namn (inte slumpas), så en omkörning
 * skriver samma rader. Fel samlas med radnummer i `Problems`.
 */
import { createHash } from 'node:crypto';
import type { CsvRecord } from './seed-csv-parser.js';

export const VENUE_COLUMNS = [
  'venue',
  'city',
  'section',
  'rows',
  'seats_per_row',
  'section_x',
  'section_y',
  'section_w',
  'section_h',
  'section_rotation',
  'stage_x',
  'stage_y',
  'stage_w',
  'stage_h',
] as const;

const MAX_ROWS = 26;
const MAP_WIDTH = 1000;
const MAP_HEIGHT = 700;

export interface Layout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
}
export interface PlannedSection {
  readonly id: string;
  readonly name: string;
  readonly displayOrder: number;
  readonly layout: Layout;
}
export interface PlannedVenueSeat {
  readonly id: string;
  readonly sectionId: string;
  readonly sectionOrder: number;
  readonly row: string;
  readonly number: number;
  readonly x: number;
  readonly y: number;
}
export interface PlannedVenue {
  readonly id: string;
  readonly name: string;
  readonly city: string;
  readonly stage: Omit<Layout, 'rotation'>;
  readonly sections: readonly PlannedSection[];
  readonly seats: readonly PlannedVenueSeat[];
}
/** Härleder ett giltigt v4-format-UUID ur en nyckel (samma mönster som seed-real-venue.ts). */
export function deriveUuid(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** A–Z. Gränsen på 26 rader håller radnamnen sorterbara i alfabetisk ordning. */
function rowLabel(index: number): string {
  return String.fromCharCode(65 + index);
}

interface VenueDraft {
  city: string;
  stage: Omit<Layout, 'rotation'>;
  sections: { name: string; rows: number; seatsPerRow: number; layout: Layout }[];
}

/** Läser heltalskolumner enligt `{fält: [kolumn, min, max]}`; undefined om någon är ogiltig. */
function readInts<K extends string>(
  values: Readonly<Record<string, string>>,
  spec: Record<K, readonly [column: string, min: number, max: number]>,
): Record<K, number> | undefined {
  const result: Partial<Record<K, number>> = {};
  // `as`: Object.keys ger string[], men nycklarna är exakt K (spec är Record<K, …>).
  for (const key of Object.keys(spec) as K[]) {
    const [column, min, max] = spec[key];
    const parsed = toInt(values[column] ?? '', min, max);
    if (parsed === undefined) return undefined;
    result[key] = parsed;
  }
  // `as`: varje nyckel i spec har fått ett värde ovan (annars returnerades undefined).
  return result as Record<K, number>;
}

function readVenueRecord(
  record: CsvRecord,
  drafts: Map<string, VenueDraft>,
  problems: Problems,
): void {
  const v = record.values;
  const fail = (message: string): void => problems.add('venues.csv', record.line, message);
  const name = v['venue'] ?? '';
  const city = v['city'] ?? '';
  const section = v['section'] ?? '';
  if (name === '' || section === '' || city === '') {
    return fail('venue, city och section måste fyllas i');
  }
  const size = readInts(v, {
    rows: ['rows', 1, MAX_ROWS],
    seatsPerRow: ['seats_per_row', 1, 99],
  });
  if (size === undefined) {
    return fail(`rows måste vara 1–${String(MAX_ROWS)} och seats_per_row 1–99 (heltal)`);
  }
  const layout = readInts(v, {
    x: ['section_x', 0, MAP_WIDTH],
    y: ['section_y', 0, MAP_HEIGHT],
    width: ['section_w', 1, MAP_WIDTH],
    height: ['section_h', 1, MAP_HEIGHT],
    rotation: ['section_rotation', -180, 180],
  });
  const stage = readInts(v, {
    x: ['stage_x', 0, MAP_WIDTH],
    y: ['stage_y', 0, MAP_HEIGHT],
    width: ['stage_w', 1, MAP_WIDTH],
    height: ['stage_h', 1, MAP_HEIGHT],
  });
  if (layout === undefined || stage === undefined) {
    return fail(
      `section_* och stage_* måste vara heltal inom kartan 0–${String(MAP_WIDTH)} × 0–${String(MAP_HEIGHT)}`,
    );
  }
  const draft = drafts.get(name) ?? { city, stage, sections: [] };
  if (draft.city !== city) return fail(`venuen "${name}" har olika city på olika rader`);
  if (JSON.stringify(draft.stage) !== JSON.stringify(stage)) {
    return fail(`stage_* måste vara identiskt på alla rader för venuen "${name}"`);
  }
  if (draft.sections.some((existing) => existing.name === section)) {
    return fail(`sektionen "${section}" finns redan i venuen "${name}"`);
  }
  draft.sections.push({ name: section, ...size, layout });
  drafts.set(name, draft);
}

function planVenue(name: string, draft: VenueDraft): PlannedVenue {
  const venueId = deriveUuid(`venue:${name}`);
  const sections: PlannedSection[] = [];
  const seats: PlannedVenueSeat[] = [];
  for (const [index, section] of draft.sections.entries()) {
    const sectionId = deriveUuid(`section:${name}:${section.name}`);
    sections.push({
      id: sectionId,
      name: section.name,
      displayOrder: index + 1,
      layout: section.layout,
    });
    for (let rowIndex = 0; rowIndex < section.rows; rowIndex += 1) {
      for (let number = 1; number <= section.seatsPerRow; number += 1) {
        const row = rowLabel(rowIndex);
        seats.push({
          id: deriveUuid(`venue_seat:${name}:${section.name}:${row}:${String(number)}`),
          sectionId,
          sectionOrder: index + 1,
          row,
          number,
          x: number,
          y: rowIndex + 1,
        });
      }
    }
  }
  return { id: venueId, name, city: draft.city, stage: draft.stage, sections, seats };
}

/** Ger varje fel dess fil och rad; ett enda fel avbryter hela seeden (allt eller inget). */
export class Problems {
  readonly list: string[] = [];
  add(file: string, line: number, message: string): void {
    this.list.push(`${file} rad ${String(line)}: ${message}`);
  }
}

export function toInt(value: string, min: number, max: number): number | undefined {
  if (!/^-?\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : undefined;
}

export function planVenues(
  records: readonly CsvRecord[],
  problems: Problems,
): Map<string, PlannedVenue> {
  const drafts = new Map<string, VenueDraft>();
  for (const record of records) {
    readVenueRecord(record, drafts, problems);
  }
  return new Map(
    [...drafts.entries()].map(([name, draft]) => [name, planVenue(name, draft)] as const),
  );
}
