/**
 * Seatmap routes (docs/plan.md "Realtid"): venue-sektioner + geometri
 * är globala och anonyma, per-event stolsstatus är anonym men
 * event-scopad. Alla tre är publika GET:er — se seatmap-controller.ts
 * för varför (Cloudflare edge-cache kräver ett anonymt, cookie-fritt svar).
 */
import type { FastifyInstance } from 'fastify';
import {
  createGetSectionGeometryHandler,
  createGetSectionSeatStatusHandler,
  createListVenueSectionsHandler,
  type SeatmapServiceDeps,
} from '../controllers/seatmap-controller.js';

export function registerSeatmapRoutes(app: FastifyInstance, deps: SeatmapServiceDeps): void {
  app.get('/venues/:venueId/sections', createListVenueSectionsHandler(deps));
  app.get('/venues/:venueId/sections/:sectionId/seats', createGetSectionGeometryHandler(deps));
  app.get(
    '/events/:eventId/sections/:sectionId/seats/status',
    createGetSectionSeatStatusHandler(deps),
  );
}
