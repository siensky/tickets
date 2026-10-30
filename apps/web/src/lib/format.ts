/**
 * Den enda platsen för `Intl`-formatering (docs/plan.md 7.11): priser (öre → "1 185 kr")
 * och datum i svensk tid. Alla tider visas i Europe/Stockholm, oavsett webbläsarens zon.
 */

const TIME_ZONE = 'Europe/Stockholm';
const priceFormatter = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 });
const dateFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TIME_ZONE,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function formatPrice(cents: number): string {
  return `${priceFormatter.format(cents / 100)} kr`;
}

export function formatPriceRange(minCents: number | null, maxCents: number | null): string {
  if (minCents === null || maxCents === null) {
    return '';
  }
  return minCents === maxCents
    ? formatPrice(minCents)
    : `${formatPrice(minCents)} – ${formatPrice(maxCents)}`;
}

export interface EventDateParts {
  readonly weekday: string;
  readonly day: string;
  readonly month: string;
  readonly year: string;
  readonly time: string;
}

export function getEventDateParts(iso: string): EventDateParts {
  const parts = Object.fromEntries(
    dateFormatter.formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
  );
  const get = (type: string): string => parts[type] ?? '';
  return {
    weekday: get('weekday').replace('.', ''),
    day: get('day'),
    month: get('month').replace('.', ''),
    year: get('year'),
    time: `${get('hour')}:${get('minute')}`,
  };
}

/** "fre 27 nov 2026 · 20:00" */
export function formatEventDate(iso: string): string {
  const { weekday, day, month, year, time } = getEventDateParts(iso);
  return `${weekday} ${day} ${month} ${year} · ${time}`;
}
