/**
 * Stripes webhook-endpoint (docs/plan.md "Webhook-hantering": "Raw body
 * krävs för HMAC-verifiering ... signaturen misslyckas ALLTID utan
 * raw-body-konfiguration på just den routen"). `request.body` är redan
 * en Buffer här — routes/webhooks.ts registrerar denna route i en EGEN,
 * inkapslad Fastify-kontext med en content-type-parser som inte
 * JSON-avkodar, så den globala appens vanliga JSON-parsing för alla
 * andra routes lämnas orörd.
 */
import { ValidationError } from '@tickets/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { handleStripeWebhook, type WebhookServiceDeps } from '../services/webhook-service.js';

// Återexporterad åt routes/webhooks.ts — se queue-controller.ts:s
// motsvarande kommentar.
export type { WebhookServiceDeps };

const SIGNATURE_HEADER = 'stripe-signature';

export function createStripeWebhookHandler(deps: WebhookServiceDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const signatureHeader = request.headers[SIGNATURE_HEADER];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    if (signature === undefined) {
      throw new ValidationError('missing Stripe-Signature header');
    }
    if (!Buffer.isBuffer(request.body)) {
      throw new ValidationError('expected the raw request body as a Buffer');
    }

    const result = await handleStripeWebhook(deps, request.body, signature);
    reply.code(200).send(result);
  };
}
