/**
 * Stripes webhook-route (docs/plan.md "Webhook-hantering"). Registreras
 * i en EGEN, inkapslad Fastify-kontext med en content-type-parser som
 * lämnar kroppen som en rå Buffer — Fastifys inbyggda JSON-parsing för
 * alla ANDRA routes är orörd, eftersom contentTypeParser-registrering
 * inte läcker uppåt eller i sidled mellan syskon-kontexter.
 *
 * Rate limiting-undantaget (docs/plan.md "Betalning": "Stripe-webhooken
 * undantas från rate limitingen") sköts av routes/rate-limit.ts, som
 * matchar på `request.url` — ett hook registrerat på root-instansen
 * fortsätter gälla här trots inkapslingen (hooks ärvs nedåt, till
 * skillnad från content-type-parsers som INTE ärvs uppåt).
 */
import type { FastifyInstance } from 'fastify';
import {
  createStripeWebhookHandler,
  type WebhookServiceDeps,
} from '../controllers/webhook-controller.js';

export function registerWebhookRoutes(app: FastifyInstance, deps: WebhookServiceDeps): void {
  app.register((instance, _opts, done) => {
    instance.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, next) => {
        next(null, body);
      },
    );
    instance.post('/webhooks/stripe', createStripeWebhookHandler(deps));
    done();
  });
}
