/**
 * Kategorierna navbaren bläddrar på (docs/plan.md Fas 6). Egen,
 * handskriven kopia av backendens `EVENT_CATEGORIES`
 * (shared/schemas/src/events-query.ts) — apps/web importerar
 * medvetet INGET `@tickets/*`-paket (samma mönster som `EventSummary`
 * m.fl. i api-client.ts: frontendens typer speglar backendens för hand
 * i stället för att dela paket över gränsen mellan en statisk SPA-bundle
 * och Node-tjänsterna).
 */
export const EVENT_CATEGORIES = ['music', 'sports', 'theatre', 'festival'] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<EventCategory, string> = {
  music: 'Musik',
  sports: 'Sport',
  theatre: 'Teater',
  festival: 'Festival',
};

/** Typguard i stället för en `as`-kastning (docs/rules.md §2: `as` bara i mappers) — delad av Navbar och HomePage. */
export function isEventCategory(value: string | null | undefined): value is EventCategory {
  return (EVENT_CATEGORIES as readonly string[]).includes(value ?? '');
}
