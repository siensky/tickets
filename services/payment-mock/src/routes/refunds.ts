import type { FastifyInstance } from 'fastify';
import { createCreateRefundHandler } from '../controllers/refunds-controller.js';

export function registerRefundsRoutes(app: FastifyInstance): void {
  app.post('/v1/refunds', createCreateRefundHandler());
}
