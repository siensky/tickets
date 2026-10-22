import type { FastifyInstance } from 'fastify';
import {
  createCreateCheckoutSessionHandler,
  type CheckoutSessionsDeps,
} from '../controllers/checkout-sessions-controller.js';

export function registerCheckoutSessionsRoutes(
  app: FastifyInstance,
  deps: CheckoutSessionsDeps,
): void {
  app.post('/v1/checkout/sessions', createCreateCheckoutSessionHandler(deps));
}
