/**
 * `POST /scans` (docs/plan.md 7.13 E7). Bakom `createRequirePermission` (`request.staffSub`).
 * Svarar alltid 200 med ett `result`: en nekad biljett är ett affärsutfall, inte ett HTTP-fel.
 * 400 bara vid ogiltig body.
 */
import { UnauthorizedError, ValidationError } from '@tickets/domain';
import { scanBodySchema } from '@tickets/schemas';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { scanTicket, type ScanServiceDeps } from '../services/scan-service.js';

export type { ScanServiceDeps };

export function createScanHandler(deps: ScanServiceDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const parsed = scanBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('scan body is not valid', { issues: parsed.error.issues });
    }
    const staffSub = request.staffSub;
    if (staffSub === undefined) {
      throw new UnauthorizedError('missing staff authentication context');
    }
    const outcome = await scanTicket(deps, { ...parsed.data, staffSub });
    reply.send(outcome);
  };
}
