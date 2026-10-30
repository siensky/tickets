import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EVENT_COLUMNS,
  SeedValidationError,
  VENUE_COLUMNS,
  buildSeedPlan,
} from '../../src/mappers/seed-csv-mapper.js';

const SEED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../seed');

const VENUES = [
  VENUE_COLUMNS.join(','),
  'Arena,Stad,Golv,2,3,100,100,400,200,0,300,20,400,60',
  'Arena,Stad,Läktare,1,4,100,350,400,100,0,300,20,400,60',
].join('\n');

function eventLine(
  overrides: Partial<Record<(typeof EVENT_COLUMNS)[number], string>> = {},
): string {
  const base: Record<(typeof EVENT_COLUMNS)[number], string> = {
    slug: 'min-konsert',
    title: 'Min konsert',
    artist: 'Artist',
    category: 'music',
    venue: 'Arena',
    starts_at: '2026-12-05T19:30:00+01:00',
    sales_open_at: '2026-10-01T10:00:00+02:00',
    sales_close_at: '2026-12-05T19:30:00+01:00',
    price_sek: '500',
    featured: 'true',
    image: 'min-konsert.webp',
    description: 'En text, med komma',
    section_prices: 'Läktare:300',
  };
  const merged = { ...base, ...overrides };
  return EVENT_COLUMNS.map((column) => `"${merged[column]}"`).join(',');
}

const eventsCsv = (...lines: string[]): string =>
  [EVENT_COLUMNS.join(','), ...lines].join('\n');
const IMAGES = new Set(['min-konsert.webp']);

describe('buildSeedPlan', () => {
  it('planerar arenor, sektioner, stolar och eventstolar med serverpriser per sektion', () => {
    const plan = buildSeedPlan(VENUES, eventsCsv(eventLine()), IMAGES);

    const venue = plan.venues[0];
    expect(venue?.sections.map((section) => section.name)).toEqual(['Golv', 'Läktare']);
    expect(venue?.seats).toHaveLength(2 * 3 + 4);
    expect(venue?.seats[0]).toMatchObject({
      row: 'A',
      number: 1,
      x: 1,
      y: 1,
      sectionOrder: 1,
    });
    const event = plan.events[0];
    expect(event).toMatchObject({
      slug: 'min-konsert',
      imageKey: 'images/min-konsert.webp',
      featured: true,
    });
    expect(event?.seats).toHaveLength(10);
    const prices = new Set(
      event?.seats.map(
        (seat) => `${seat.sectionId === venue?.sections[1]?.id}:${String(seat.priceCents)}`,
      ),
    );
    expect(prices).toEqual(new Set(['false:50000', 'true:30000']));
    expect(new Set(event?.seats.map((seat) => seat.ticketNumber)).size).toBe(10);
  });

  it('härleder samma id:n vid varje körning', () => {
    const first = buildSeedPlan(VENUES, eventsCsv(eventLine()), IMAGES);
    const second = buildSeedPlan(VENUES, eventsCsv(eventLine()), IMAGES);

    expect(second.events[0]?.id).toBe(first.events[0]?.id);
    expect(second.events[0]?.seats[0]?.id).toBe(first.events[0]?.seats[0]?.id);
    expect(second.venues[0]?.id).toBe(first.venues[0]?.id);
  });

  it.each([
    ['okänd venue', { venue: 'Finns inte' }, /okänd venue/],
    ['fel datumformat', { starts_at: '5 december 2026' }, /ISO 8601/],
    ['datum utan tidszon', { starts_at: '2026-12-05T19:30:00' }, /ISO 8601/],
    ['saknad bild', { image: 'saknas.webp' }, /saknas i seed\/images/],
    ['okänd kategori', { category: 'cooking' }, /category/],
    ['okänd sektion i section_prices', { section_prices: 'Balkong:300' }, /section_prices/],
    [
      'öppning efter stängning',
      { sales_open_at: '2027-01-01T10:00:00+01:00' },
      /sales_open_at/,
    ],
    ['ogiltig featured', { featured: 'ja' }, /featured/],
  ])('avbryter med radnummer vid %s', (_name, overrides, pattern) => {
    expect(() => buildSeedPlan(VENUES, eventsCsv(eventLine(overrides)), IMAGES)).toThrow(
      pattern,
    );
    try {
      buildSeedPlan(VENUES, eventsCsv(eventLine(overrides)), IMAGES);
    } catch (error) {
      expect(error).toBeInstanceOf(SeedValidationError);
      expect((error as SeedValidationError).problems[0]).toMatch(/events\.csv rad 2:/);
    }
  });

  it('avvisar en dubblett av slug och en scen som skiljer sig inom samma venue', () => {
    expect(() => buildSeedPlan(VENUES, eventsCsv(eventLine(), eventLine()), IMAGES)).toThrow(
      /rad 3: slug "min-konsert" finns redan/,
    );
    const badStage = VENUES.replace('300,20,400,60\nArena', '300,20,400,99\nArena');
    expect(() => buildSeedPlan(badStage, eventsCsv(eventLine()), IMAGES)).toThrow(
      /venues\.csv rad 3: stage_\*/,
    );
  });

  it('samlar alla fel i stället för att stanna vid det första', () => {
    expect(() =>
      buildSeedPlan(
        VENUES,
        eventsCsv(eventLine({ venue: 'Nej' }), eventLine({ slug: 'b', image: 'nej.webp' })),
        IMAGES,
      ),
    ).toThrow(/rad 2[\s\S]*rad 3/);
  });
});

describe('seed/*.csv i repot', () => {
  it('är giltiga: 20 events, 5 per kategori, 4 featured, 5 arenor', () => {
    const read = (name: string): string => readFileSync(resolve(SEED_DIR, name), 'utf8');
    const plan = buildSeedPlan(
      read('venues.csv'),
      read('events.csv'),
      new Set(readdirSync(resolve(SEED_DIR, 'images'))),
    );

    expect(plan.venues).toHaveLength(5);
    expect(plan.events).toHaveLength(20);
    for (const category of ['music', 'sports', 'theatre', 'festival']) {
      expect(plan.events.filter((event) => event.category === category)).toHaveLength(5);
    }
    expect(plan.events.filter((event) => event.featured)).toHaveLength(4);
    const seatCounts = plan.venues.map((venue) => venue.seats.length).sort((a, b) => a - b);
    expect(seatCounts.slice(0, 3).every((count) => count >= 60 && count <= 200)).toBe(true);
    expect(seatCounts.slice(3).every((count) => count >= 1500 && count <= 3000)).toBe(true);
  });
});
