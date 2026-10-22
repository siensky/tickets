/**
 * Stripe-API-kompatibel YTA för `POST /v1/refunds` (docs/plan.md
 * "Betalning": skyddsnätets automatiska återbetalning anropar denna
 * under lasttest, exakt samma klientkod som mot riktiga Stripe).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export function createCreateRefundHandler() {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const raw = typeof request.body === 'string' ? request.body : '';
    const params = new URLSearchParams(raw);
    reply.code(200).send({
      id: `re_mock_${randomUUID()}`,
      object: 'refund',
      payment_intent: params.get('payment_intent') ?? '',
      status: 'succeeded',
    });
  };
}
