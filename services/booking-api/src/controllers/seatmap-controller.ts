/**
 * Seatmap HTTP-ytor (docs/plan.md "Realtid"): venue-sektioner och
 * stolgeometri är ANONYMA GET-svar som sätter aldrig cookies, med
 * explicit `Cache-Control` — förutsättningen för att Cloudflares
 * edge-cache (infra/terraform/cloudflare.tf) faktiskt kickar in.
 * Geometri cachas länge (statisk venue-layout); status cachas 1 s,
 * matchande klientens 2 s polling.
 */
import { ValidationError } from '@tickets/domain';
import {
  eventSectionParamSchema,
  venueIdParamSchema,
  venueSectionParamSchema,
} from '@tickets/schemas';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  getSectionGeometry,
  getSectionSeatStatus,
  listVenueSections,
  type SeatmapServiceDeps,
} from '../services/seatmap-service.js';

export type { SeatmapServiceDeps };

const EDGE_CACHE_GEOMETRY = 'public, max-age=2592000';
const EDGE_CACHE_STATUS = 'public, max-age=1';

export function createListVenueSectionsHandler(deps: SeatmapServiceDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const parsed = venueIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new ValidationError('venueId route param is not a valid UUID', {
        issues: parsed.error.issues,
      });
    }
    const sections = await listVenueSections(deps, parsed.data.venueId);
    reply.header('cache-control', EDGE_CACHE_GEOMETRY).send({ sections });
  };
}

export function createGetSectionGeometryHandler(deps: SeatmapServiceDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const parsed = venueSectionParamSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new ValidationError('venueId/sectionId route params are not valid UUIDs', {
        issues: parsed.error.issues,
      });
    }
    const seats = await getSectionGeometry(deps, parsed.data.venueId, parsed.data.sectionId);
    reply.header('cache-control', EDGE_CACHE_GEOMETRY).send({ seats });
  };
}

export function createGetSectionSeatStatusHandler(deps: SeatmapServiceDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const parsed = eventSectionParamSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new ValidationError('eventId/sectionId route params are not valid UUIDs', {
        issues: parsed.error.issues,
      });
    }
    const seats = await getSectionSeatStatus(deps, parsed.data.eventId, parsed.data.sectionId);
    reply.header('cache-control', EDGE_CACHE_STATUS).send({ seats });
  };
}
