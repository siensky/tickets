/**
 * In-memory lagring av skapade sessioner (docs/plan.md "payment-mock
 * för lasttest"). Ingen databas — en mock som tappar sitt tillstånd vid
 * omstart under ett lasttest är ofarligt (det är inte riktiga pengar),
 * och en databas hade varit overkill för något som bara behöver
 * överleva mellan "skapa session" och "leverera webhook" i samma
 * process.
 */

export interface StoredSession {
  readonly id: string;
  readonly paymentIntentId: string;
  readonly amountTotal: number;
  readonly customerEmail: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface SessionStore {
  set(session: StoredSession): void;
  get(id: string): StoredSession | undefined;
}

export function createSessionStore(): SessionStore {
  const sessions = new Map<string, StoredSession>();
  return {
    set(session) {
      sessions.set(session.id, session);
    },
    get(id) {
      return sessions.get(id);
    },
  };
}
