/** `POST /scans` (docs/plan.md 7.13 E7): kräver permissionen `scan:tickets`. */
import type { Auth0Verifier } from '@tickets/auth';
import type { FastifyInstance } from 'fastify';
import { createRequirePermission } from '../controllers/auth0-controller.js';
import { createScanHandler, type ScanServiceDeps } from '../controllers/scans-controller.js';

export const SCAN_PERMISSION = 'scan:tickets';

export function registerScanRoutes(
  app: FastifyInstance,
  deps: ScanServiceDeps,
  auth0Verifier: Auth0Verifier,
): void {
  app.post('/scans', {
    preHandler: createRequirePermission(auth0Verifier, SCAN_PERMISSION),
    handler: createScanHandler(deps),
  });
}
