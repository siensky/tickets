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
  eventIdParamSchema,
  eventSectionParamSchema,
  venueIdParamSchema,
  venueSectionParamSchema,
} from '@tickets/schemas';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { setPublicCacheHeaders } from './http-headers.js';
import {
  getSectionGeometry,
  getSectionSeatStatus,
  getSectionSummary,
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
    setPublicCacheHeaders(reply, EDGE_CACHE_GEOMETRY);
    reply.send({ sections });
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
    setPublicCacheHeaders(reply, EDGE_CACHE_GEOMETRY);
    reply.send({ seats });
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
    setPublicCacheHeaders(reply, EDGE_CACHE_STATUS);
    reply.send({ seats });
  };
}

export function createGetSectionSummaryHandler(deps: SeatmapServiceDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const parsed = eventIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new ValidationError('eventId route param is not a valid UUID', {
        issues: parsed.error.issues,
      });
    }
    const summary = await getSectionSummary(deps, parsed.data.eventId);
    // Samma svar för alla (ingen inloggning, ingen kötoken). 0 = ingen header, och kanten cachar då inget
    // (regeln i cloudflare.tf följer origin-headern).
    const maxAge = deps.summaryCacheSeconds ?? 0;
    if (maxAge > 0) {
      setPublicCacheHeaders(reply, `public, max-age=${String(maxAge)}`);
    }
    reply.send(summary);
  };
}
