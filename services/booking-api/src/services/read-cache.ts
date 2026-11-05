/**
 * Kort läscache i podden för heta, billiga läsningar som annars tar en databasanslutning per anrop
 * (försäljningsfönstret, eventsidan, reservationskonfigurationen). Under lasttestet var alla fyra
 * anslutningar per shard och podd upptagna hela tiden, och anrop som väntade mer än 5 s fick 500.
 *
 * - Samtidiga missar på samma nyckel delar på EN laddning (single-flight).
 * - `ttlMs` 0 = helt avstängd: varje anrop laddar själv, exakt som utan cache (standard lokalt och i
 *   CI, så att testerna ser varje ändring direkt).
 * - Ett fel cachas aldrig: nästa anrop försöker igen.
 */

export interface ReadCache<T> {
  get(key: string, load: () => Promise<T>): Promise<T>;
}

/** Övre gräns för antalet nycklar, så att en ström av okända id:n inte kan växa minnet obegränsat. */
const MAX_ENTRIES = 1000;

export function createReadCache<T>(
  ttlMs: number,
  now: () => number = () => performance.now(),
): ReadCache<T> {
  const entries = new Map<string, { readonly value: T; readonly expiresAt: number }>();
  const inFlight = new Map<string, Promise<T>>();

  function store(key: string, value: T): void {
    // Ta bort nyckeln först, så att den hamnar sist i ordningen när den skrivs igen. En Map minns
    // insättningsordningen, så den första nyckeln är alltid den som skrevs för längst sedan: en ström
    // av okända id:n trycker bara ut de äldsta, inte de heta.
    entries.delete(key);
    if (entries.size >= MAX_ENTRIES) {
      const oldest = entries.keys().next();
      if (oldest.done !== true) {
        entries.delete(oldest.value);
      }
    }
    entries.set(key, { value, expiresAt: now() + ttlMs });
  }

  return {
    async get(key, load) {
      if (ttlMs <= 0) {
        return load();
      }
      const entry = entries.get(key);
      if (entry !== undefined && entry.expiresAt > now()) {
        return entry.value;
      }
      const pending = inFlight.get(key);
      if (pending !== undefined) {
        return pending;
      }
      const loading = load()
        .then((value) => {
          store(key, value);
          return value;
        })
        .finally(() => {
          inFlight.delete(key);
        });
      inFlight.set(key, loading);
      return loading;
    },
  };
}

/**
 * Bara single-flight, ingen lagring: samtidiga anrop med samma nyckel delar på den laddning som redan
 * pågår. Ingen inaktualitet tillkommer, så den är alltid på (även lokalt och i CI).
 */
export function createSingleFlight<T>(): ReadCache<T> {
  const inFlight = new Map<string, Promise<T>>();
  return {
    get(key, load) {
      const pending = inFlight.get(key);
      if (pending !== undefined) {
        return pending;
      }
      const loading = load().finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, loading);
      return loading;
    },
  };
}
