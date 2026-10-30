/**
 * CSV → seed-plan (docs/plan.md 7.6, 7.13 E3): validerar HELA `venues.csv` och
 * `events.csv` och räknar ut alla rader som ska skrivas (arenor, sektioner,
 * stolar, events, eventstolar) innan något når databasen. Alla fel samlas med
 * radnummer, och ett enda fel avbryter hela seeden (allt eller inget). Arenorna
 * planeras i `seed-venue-mapper.ts`; här planeras eventen och hela planen.
 */
import { parseCsv, type CsvRecord } from './seed-csv-parser.js';
import {
  Problems,
  VENUE_COLUMNS,
  deriveUuid,
  planVenues,
  toInt,
  type PlannedVenue,
} from './seed-venue-mapper.js';

export type {
  Layout,
  PlannedSection,
  PlannedVenue,
  PlannedVenueSeat,
} from './seed-venue-mapper.js';
export { VENUE_COLUMNS } from './seed-venue-mapper.js';

export const EVENT_COLUMNS = [
  'slug',
  'title',
  'artist',
  'category',
  'venue',
  'starts_at',
  'sales_open_at',
  'sales_close_at',
  'price_sek',
  'featured',
  'image',
  'description',
  'section_prices',
] as const;

const CATEGORIES = ['music', 'sports', 'theatre', 'festival'] as const;
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/;

export interface PlannedEventSeat {
  readonly id: string;
  readonly venueSeatId: string;
  readonly sectionId: string;
  readonly row: string;
  readonly number: number;
  readonly ticketNumber: string;
  readonly priceCents: number;
}
export interface PlannedEvent {
  readonly id: string;
  readonly venueId: string;
  readonly slug: string;
  readonly title: string;
  readonly artist: string;
  readonly category: string;
  readonly startsAt: string;
  readonly salesOpenAt: string;
  readonly salesCloseAt: string;
  readonly featured: boolean;
  readonly imageKey: string;
  readonly description: string;
  readonly seats: readonly PlannedEventSeat[];
}
export interface SeedPlan {
  readonly venues: readonly PlannedVenue[];
  readonly events: readonly PlannedEvent[];
}

export class SeedValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `Seed-filerna är ogiltiga:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
    );
  }
}

function parseSectionPrices(
  raw: string,
  venue: PlannedVenue,
  fail: (message: string) => void,
): Map<string, number> {
  const prices = new Map<string, number>();
  for (const part of raw === '' ? [] : raw.split(';')) {
    const [sectionName, price, ...rest] = part.split(':');
    const cents = toInt(price ?? '', 1, 100_000);
    const section = venue.sections.find((candidate) => candidate.name === sectionName);
    if (rest.length > 0 || section === undefined || cents === undefined) {
      fail(
        `section_prices: "${part}" är inte "Sektion:pris" för en sektion i "${venue.name}"`,
      );
    } else {
      prices.set(section.id, cents * 100);
    }
  }
  return prices;
}

/** ISO 8601 med tidszon för alla tre tider, öppning före stängning. Ger ett felmeddelande som sträng annars. */
function readTimes(
  v: Readonly<Record<string, string>>,
): { startsAt: string; salesOpenAt: string; salesCloseAt: string } | string {
  const [startsAt = '', salesOpenAt = '', salesCloseAt = ''] = [
    'starts_at',
    'sales_open_at',
    'sales_close_at',
  ].map((column) => v[column] ?? '');
  const bad = [startsAt, salesOpenAt, salesCloseAt].find(
    (value) => !ISO_WITH_ZONE.test(value) || Number.isNaN(Date.parse(value)),
  );
  if (bad !== undefined) {
    return `"${bad}" är inte ISO 8601 med tidszon, t.ex. 2026-12-05T19:30:00+01:00`;
  }
  return Date.parse(salesOpenAt) > Date.parse(salesCloseAt)
    ? 'sales_open_at ligger efter sales_close_at'
    : { startsAt, salesOpenAt, salesCloseAt };
}

function planEventSeats(
  slug: string,
  venue: PlannedVenue,
  sectionPrices: ReadonlyMap<string, number>,
  defaultPriceCents: number,
): PlannedEventSeat[] {
  return venue.seats.map((seat) => ({
    id: deriveUuid(`seat:${slug}:${seat.id}`),
    venueSeatId: seat.id,
    sectionId: seat.sectionId,
    row: seat.row,
    number: seat.number,
    ticketNumber: `${slug}-S${String(seat.sectionOrder)}${seat.row}${String(seat.number)}`,
    priceCents: sectionPrices.get(seat.sectionId) ?? defaultPriceCents,
  }));
}

function planEvent(
  record: CsvRecord,
  venues: ReadonlyMap<string, PlannedVenue>,
  imageFiles: ReadonlySet<string>,
  problems: Problems,
): PlannedEvent | undefined {
  const v = record.values;
  const fail = (message: string): undefined => {
    problems.add('events.csv', record.line, message);
    return undefined;
  };
  const slug = v['slug'] ?? '';
  const venue = venues.get(v['venue'] ?? '');
  const category = CATEGORIES.find((candidate) => candidate === v['category']);
  const priceSek = toInt(v['price_sek'] ?? '', 1, 100_000);
  if (!SLUG_PATTERN.test(slug))
    return fail('slug måste vara gemener, siffror och bindestreck');
  if (venue === undefined) return fail(`okänd venue "${v['venue'] ?? ''}"`);
  if (category === undefined)
    return fail(`category måste vara en av ${CATEGORIES.join(', ')}`);
  if (priceSek === undefined) return fail('price_sek måste vara ett heltal i kronor');
  const times = readTimes(v);
  if (typeof times === 'string') return fail(times);
  const { startsAt, salesOpenAt, salesCloseAt } = times;
  if (v['featured'] !== 'true' && v['featured'] !== 'false')
    return fail('featured måste vara true eller false');
  const image = v['image'] ?? '';
  if (!imageFiles.has(image)) return fail(`bilden "${image}" saknas i seed/images/`);
  const sectionPrices = parseSectionPrices(v['section_prices'] ?? '', venue, (m) => fail(m));
  const eventId = deriveUuid(`event:${slug}`);
  const seats = planEventSeats(slug, venue, sectionPrices, priceSek * 100);
  return {
    id: eventId,
    venueId: venue.id,
    slug,
    title: v['title'] ?? '',
    artist: v['artist'] ?? '',
    category,
    startsAt,
    salesOpenAt,
    salesCloseAt,
    featured: v['featured'] === 'true',
    imageKey: `images/${image}`,
    description: v['description'] ?? '',
    seats,
  };
}

export function buildSeedPlan(
  venuesCsv: string,
  eventsCsv: string,
  imageFiles: ReadonlySet<string>,
): SeedPlan {
  const problems = new Problems();
  const venues = planVenues(parseCsv(venuesCsv, VENUE_COLUMNS), problems);
  const seenSlugs = new Set<string>();
  const events: PlannedEvent[] = [];
  for (const record of parseCsv(eventsCsv, EVENT_COLUMNS)) {
    const event = planEvent(record, venues, imageFiles, problems);
    if (event !== undefined && seenSlugs.has(event.slug)) {
      problems.add('events.csv', record.line, `slug "${event.slug}" finns redan`);
    } else if (event !== undefined) {
      seenSlugs.add(event.slug);
      events.push(event);
    }
  }
  if (problems.list.length > 0) {
    throw new SeedValidationError(problems.list);
  }
  return { venues: [...venues.values()], events };
}
