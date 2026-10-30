import type { FastifyInstance } from 'fastify';
import {
  createMockCheckoutHandler,
  type SessionStore,
} from '../controllers/mock-checkout-controller.js';

export function registerMockCheckoutRoutes(
  app: FastifyInstance,
  sessionStore: SessionStore,
): void {
  app.get('/mock-checkout/:sessionId', createMockCheckoutHandler(sessionStore));
}
