/**
 * Redis key- och kanalnamn (docs/plan.md "Redis — användningsområden").
 * Centraliserat så inget anropsställe hittar på ett eget format som
 * glider isär från ett annat.
 */

export function waitingRoomKey(eventId: string): string {
  return `waitingroom:${eventId}`;
}

/** Håller koll på vilka event som just nu har någon i väntrummet, så insläppsjobbet inte behöver fråga Postgres för att veta vilka event-ID:n det ska bearbeta. */
export function waitingRoomActiveEventsKey(): string {
  return 'waitingroom:active-events';
}

export function admittedKey(eventId: string, queueTokenId: string): string {
  return `admitted:${eventId}:${queueTokenId}`;
}

export function revokedKey(queueTokenId: string): string {
  return `revoked:${queueTokenId}`;
}

export function seatMarksKey(queueTokenId: string): string {
  return `seatmarks:${queueTokenId}`;
}

/** Reverse index of seatMarksKey — which queue tokens currently have THIS seat marked, so "din stol togs" (docs/plan.md "Realtid") can notify every one of them, not just the reservation's own owner. */
export function seatMarkHoldersKey(eventId: string, seatId: string): string {
  return `seatmark-holders:${eventId}:${seatId}`;
}

/** Stolsstatuscache per sektion (docs/plan.md "Redis — användningsområden": "seatmap:<event>:<sektion> → JSON"). */
export function seatmapStatusKey(eventId: string, sectionId: string): string {
  return `seatmap:${eventId}:${sectionId}`;
}

export function rateLimitKey(ip: string): string {
  return `ratelimit:${ip}`;
}

export function notificationDedupeKey(messageId: string): string {
  return `notif-dedupe:${messageId}`;
}

export function configCacheKey(key: string): string {
  return `config:${key}`;
}

/** Pub/Sub-kanal en podd prenumererar på för att nå en specifik WS-klient (docs/plan.md "Realtid"). */
export function wsChannel(queueTokenId: string): string {
  return `ws:${queueTokenId}`;
}
