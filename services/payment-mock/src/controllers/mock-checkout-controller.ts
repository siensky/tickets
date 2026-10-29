/**
 * `GET /mock-checkout/:sessionId` (docs/plan.md 7.13 E8): stället
 * `checkoutUrl` pekar på. Svarar med 302 till sessionens `success_url`, så
 * att e2e och systemtester går samma väg som riktig Stripe (tillbaka till
 * bekräftelsesidan). Stripe ersätter `{CHECKOUT_SESSION_ID}` i URL:en;
 * mocken gör det samma. Okänd session ger 404 (mocken har ingen
 * felhanterare, så svaret skrivs direkt).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionStore } from '../services/session-store.js';

// Återexporterad åt routes/mock-checkout.ts (routes får inte importera services direkt).
export type { SessionStore };

const SESSION_ID_PLACEHOLDER = '{CHECKOUT_SESSION_ID}';

function readSessionId(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null || !('sessionId' in params)) {
    return undefined;
  }
  return typeof params.sessionId === 'string' ? params.sessionId : undefined;
}

export function createMockCheckoutHandler(sessionStore: SessionStore) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const sessionId = readSessionId(request.params);
    const session = sessionId === undefined ? undefined : sessionStore.get(sessionId);
    if (session === undefined || session.successUrl === '') {
      await reply.code(404).send({ error: 'checkout session not found' });
      return;
    }
    await reply.redirect(
      session.successUrl.replaceAll(SESSION_ID_PLACEHOLDER, session.id),
      302,
    );
  };
}
