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
  seatStatusQuerySchema,
  venueIdParamSchema,
  venueSectionParamSchema,
} from '@tickets/schemas';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { setPublicCacheHeaders } from './http-headers.js';
import {
  getSectionGeometry,
  getSectionSeatStatusBody,
  getSectionSummaryBody,
  listVenueSections,
  type SeatmapServiceDeps,
} from '../services/seatmap-service.js';

export type { SeatmapServiceDeps };

const EDGE_CACHE_GEOMETRY = 'public, max-age=2592000';
const EDGE_CACHE_STATUS = 'public, max-age=1';
// Katalogen (stolarnas id och pris) ändras inte under en försäljning: webbläsaren behåller den i 5 minuter.
// Kanten cachar den bara 1 s, eftersom cloudflare.tf:s regel för /seats/status gäller hela sökvägen.
const EDGE_CACHE_CATALOG = 'public, max-age=300';
// Servicen ger det färdiga JSON-svaret som sträng; utan typen skulle Fastify skicka det som text/plain.
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

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
    const query = seatStatusQuerySchema.safeParse(request.query);
    if (!query.success) {
      throw new ValidationError('view must be full, catalog or compact', {
        issues: query.error.issues,
      });
    }
    const view = query.data.view ?? 'full';
    const body = await getSectionSeatStatusBody(
      deps,
      parsed.data.eventId,
      parsed.data.sectionId,
      view,
      query.data.version,
    );
    setPublicCacheHeaders(reply, view === 'catalog' ? EDGE_CACHE_CATALOG : EDGE_CACHE_STATUS);
    reply.type(JSON_CONTENT_TYPE).send(body);
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
    const body = await getSectionSummaryBody(deps, parsed.data.eventId);
    // Samma svar för alla (ingen inloggning, ingen kötoken). 0 = ingen header, och kanten cachar då inget
    // (regeln i cloudflare.tf följer origin-headern).
    const maxAge = deps.summaryCacheSeconds ?? 0;
    if (maxAge > 0) {
      setPublicCacheHeaders(reply, `public, max-age=${String(maxAge)}`);
    }
    reply.type(JSON_CONTENT_TYPE).send(body);
  };
}
