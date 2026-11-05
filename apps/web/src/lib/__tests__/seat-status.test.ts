import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getSectionSeatStatus,
  mergeSeatStatus,
  SeatCatalogMismatchError,
  type CompactSeatStatus,
  type SeatCatalog,
} from '../seat-status.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATALOG: SeatCatalog = {
  version: 'v1',
  seats: [
    { seatId: 's1', venueSeatId: 'vs1', priceCents: 39_500 },
    { seatId: 's2', venueSeatId: 'vs2', priceCents: 49_500 },
    { seatId: 's3', venueSeatId: 'vs3', priceCents: 39_500 },
  ],
};
const COMPACT: CompactSeatStatus = {
  version: 'v1',
  statuses: 'ahs',
  heldUntil: [{ index: 1, until: '2030-01-01T12:05:00.000Z' }],
};
const MERGED = [
  {
    seatId: 's1',
    venueSeatId: 'vs1',
    priceCents: 39_500,
    status: 'available',
    heldUntil: null,
  },
  {
    seatId: 's2',
    venueSeatId: 'vs2',
    priceCents: 49_500,
    status: 'held',
    heldUntil: '2030-01-01T12:05:00.000Z',
  },
  { seatId: 's3', venueSeatId: 'vs3', priceCents: 39_500, status: 'sold', heldUntil: null },
];

describe('mergeSeatStatus', () => {
  it('sätter ihop katalog och status på position till samma lista som förut', () => {
    expect(mergeSeatStatus(CATALOG, COMPACT)).toEqual(MERGED);
  });

  it('vägrar slå ihop när versionerna skiljer sig', () => {
    expect(() => mergeSeatStatus(CATALOG, { ...COMPACT, version: 'v2' })).toThrow(
      SeatCatalogMismatchError,
    );
  });

  it('vägrar slå ihop när antalet stolar skiljer sig', () => {
    expect(() => mergeSeatStatus(CATALOG, { ...COMPACT, statuses: 'ah' })).toThrow(
      SeatCatalogMismatchError,
    );
  });

  it('vägrar ett okänt statustecken i stället för att gissa', () => {
    expect(() => mergeSeatStatus(CATALOG, { ...COMPACT, statuses: 'axs' })).toThrow(
      SeatCatalogMismatchError,
    );
  });

  it('ger heldUntil bara för hållna stolar', () => {
    const merged = mergeSeatStatus(CATALOG, {
      ...COMPACT,
      statuses: 'aas',
      heldUntil: [{ index: 1, until: '2030-01-01T12:05:00.000Z' }],
    });

    expect(merged[1]).toMatchObject({ status: 'available', heldUntil: null });
  });
});

/** Svarar på `?view=catalog` och `?view=compact` med det testet ger, och sparar varje anrop. */
function stubSeatApi(responses: { catalog: unknown[]; compact: unknown[] }) {
  const calls: { view: string; url: string; cache: unknown }[] = [];
  const fetchMock = vi.fn((url: string, init?: { cache?: unknown }) => {
    const view = url.includes('view=catalog') ? 'catalog' : 'compact';
    calls.push({ view, url, cache: init?.cache });
    const queue = view === 'catalog' ? responses.catalog : responses.compact;
    const body: unknown = queue.length > 1 ? queue.shift() : queue[0];
    return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(body) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    catalogCalls: () => calls.filter((call) => call.view === 'catalog'),
    compactCalls: () => calls.filter((call) => call.view === 'compact'),
  };
}

describe('getSectionSeatStatus', () => {
  it('hämtar katalogen för statusens version första gången, sedan bara statusen', async () => {
    const api = stubSeatApi({ catalog: [CATALOG], compact: [COMPACT] });

    await expect(getSectionSeatStatus('e1', 'section-a')).resolves.toEqual({ seats: MERGED });
    await getSectionSeatStatus('e1', 'section-a');

    expect(api.catalogCalls()).toHaveLength(1);
    expect(api.catalogCalls()[0]?.url).toContain('view=catalog&version=v1');
    expect(api.compactCalls()).toHaveLength(2);
    expect(api.compactCalls()[0]?.cache).toBe('no-store');
  });

  it('hämtar katalogen för den nya versionen när stolarna ändras', async () => {
    const newCatalog: SeatCatalog = { version: 'v2', seats: CATALOG.seats.slice(0, 2) };
    const api = stubSeatApi({
      catalog: [CATALOG, newCatalog],
      compact: [COMPACT, { version: 'v2', statuses: 'as', heldUntil: [] }],
    });

    await getSectionSeatStatus('e1', 'section-b');
    const after = await getSectionSeatStatus('e1', 'section-b');

    expect(after.seats.map((seat) => seat.status)).toEqual(['available', 'sold']);
    expect(api.catalogCalls().at(-1)?.url).toContain('version=v2');
  });

  it('hämtar statusen igen när katalogen redan är nyare än statusen', async () => {
    const newCatalog: SeatCatalog = { version: 'v2', seats: CATALOG.seats.slice(0, 2) };
    const api = stubSeatApi({
      catalog: [newCatalog],
      compact: [COMPACT, { version: 'v2', statuses: 'aa', heldUntil: [] }],
    });

    const result = await getSectionSeatStatus('e1', 'section-c');

    expect(result.seats).toHaveLength(2);
    expect(api.compactCalls()).toHaveLength(2);
  });

  it('kastar hellre än att använda en katalog som inte hör till statusen', async () => {
    stubSeatApi({ catalog: [CATALOG], compact: [{ ...COMPACT, version: 'v9' }] });

    await expect(getSectionSeatStatus('e1', 'section-d')).rejects.toBeInstanceOf(
      SeatCatalogMismatchError,
    );
  });

  it('använder det fulla svaret direkt från ett äldre API, utan att hämta någon katalog', async () => {
    const full = { seats: MERGED };
    const api = stubSeatApi({ catalog: [full], compact: [full] });

    await expect(getSectionSeatStatus('e1', 'section-e')).resolves.toEqual(full);
    expect(api.catalogCalls()).toHaveLength(0);
  });

  it('sparar bara de senaste fem sektionernas kataloger', async () => {
    const api = stubSeatApi({ catalog: [CATALOG], compact: [COMPACT] });
    const sections = ['lru-1', 'lru-2', 'lru-3', 'lru-4', 'lru-5', 'lru-6'];
    for (const section of sections) {
      await getSectionSeatStatus('e2', section);
    }

    await getSectionSeatStatus('e2', 'lru-6');
    expect(api.catalogCalls()).toHaveLength(6);
    await getSectionSeatStatus('e2', 'lru-1');
    expect(api.catalogCalls()).toHaveLength(7);
  });
});
