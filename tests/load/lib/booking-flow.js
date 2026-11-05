// Delade byggstenar för hela bokningsflödet (docs/plan.md "Domän och
// användarflöde"): väntrum → karta → reservation → betalning. Varje
// scenario-script komponerar dessa efter vad just DET scenariot mäter
// (queue-storm stannar vid väntrummet, normal-sale/spike-sale går hela
// vägen) — docs/rules.md §1-andan (dela det flera behöver), bara för
// k6-script istället för tjänstekod.
import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import {
  randomAuthToken,
  BASE_URL,
  WS_BASE_URL,
  EVENT_ID,
  CHALLENGE_BYPASS,
} from './config.js';

const QUEUE_TOKEN_HEADER = 'X-Queue-Token';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function joinQueue() {
  const headers = CHALLENGE_BYPASS === '' ? {} : { 'X-Challenge-Bypass': CHALLENGE_BYPASS };
  const res = http.post(`${BASE_URL}/events/${EVENT_ID}/queue/join`, null, { headers });
  const ok = check(res, { 'queue/join: 201': (r) => r.status === 201 });
  return ok ? res.json('token') : undefined;
}

// Samma tider som webbappen (apps/web/src/hooks/use-queue-admission.ts och SeatmapPage), så att testet
// belastar systemet som riktiga besökare gör (docs/loadtest-cpu-plan.md steg 3 och 6).
const QUEUE_FALLBACK_POLL_SECONDS = 15;
const QUEUE_NO_SOCKET_POLL_SECONDS = 2;
const SEAT_STATUS_POLL_SECONDS = 2;
const SECTION_SUMMARY_POLL_SECONDS = 10;
const QUEUE_END_TYPES = new Set(['sales_closed', 'sold_out']);

/**
 * En statusläsning: 'admitted', 'closed' (stängt eller slutsålt) eller 'waiting'. Ett tillfälligt fel
 * (429, 5xx, ett Cloudflare-svar) räknas som 'waiting', precis som webbappen fortsätter vänta.
 */
function readQueueStatus(token) {
  const res = http.get(`${BASE_URL}/events/${EVENT_ID}/queue/status`, {
    headers: { [QUEUE_TOKEN_HEADER]: token },
  });
  if (res.status !== 200) {
    return 'waiting';
  }
  const status = res.json('status');
  if (status === 'admitted') {
    return 'admitted';
  }
  return QUEUE_END_TYPES.has(status) ? 'closed' : 'waiting';
}

/**
 * Väntar på insläpp som webbappen gör: först en statusläsning (direktinsläppet skickar inget
 * WebSocket-meddelande), sedan WebSocket mot realtime-gateway, med en statusläsning var 15:e
 * sekund som reserv. Stängs socketen i förtid (uppgraderingen misslyckas, servern eller Cloudflare
 * stänger) pollas status varannan sekund fram till tidsgränsen, som webbappen gör utan socket.
 * Returnerar `true`/`false`, aldrig ett fel: att INTE bli insläppt inom fönstret är ett giltigt,
 * mätbart utfall.
 *
 * Skickar tokenet som FÖRSTA meddelandet, aldrig i URL:en, samma regel som
 * services/realtime-gateway/src/controllers/ws-controller.ts.
 */
export function waitForAdmissionViaWebSocket(token, maxWaitSeconds) {
  const deadline = Date.now() + maxWaitSeconds * 1000;
  const first = readQueueStatus(token);
  if (first !== 'waiting') {
    return first === 'admitted';
  }
  let admitted = false;
  let finished = false;
  const response = ws.connect(`${WS_BASE_URL}/ws`, {}, (socket) => {
    socket.on('open', () => socket.send(JSON.stringify({ token })));
    socket.on('message', (raw) => {
      const payload = JSON.parse(raw);
      if (payload.type === 'admitted') {
        admitted = true;
        finished = true;
        socket.close();
      } else if (QUEUE_END_TYPES.has(payload.type)) {
        finished = true;
        socket.close();
      }
    });
    socket.setInterval(() => {
      const status = readQueueStatus(token);
      if (status === 'admitted' || status === 'closed') {
        admitted = status === 'admitted';
        finished = true;
        socket.close();
      }
    }, QUEUE_FALLBACK_POLL_SECONDS * 1000);
    socket.setTimeout(() => socket.close(), maxWaitSeconds * 1000);
  });
  check(response, { 'ws: upgraded (101)': (r) => r && r.status === 101 });
  if (finished) {
    return admitted;
  }
  return pollUntilDeadline(token, deadline);
}

/** Socketen stängdes utan besked: polla som webbappen gör utan socket, fram till tidsgränsen. */
function pollUntilDeadline(token, deadline) {
  while (Date.now() < deadline) {
    const status = readQueueStatus(token);
    if (status !== 'waiting') {
      return status === 'admitted';
    }
    sleep(QUEUE_NO_SOCKET_POLL_SECONDS);
  }
  return false;
}

/**
 * Upptäcker lediga stolar precis som den riktiga klienten gör (karta → sektion → stolsstatus), INTE en
 * genväg direkt mot databasen. Under `browseSeconds` "väljer" besökaren stolar som i webbappen:
 * stolsstatus varannan sekund och sektionssammanfattningen var 10:e sekund. Genom Cloudflare cachas
 * stolsstatusen vid kanten, sammanfattningen inte (docs/loadtest-cpu-plan.md steg 6). Returnerar upp
 * till `maxSeats` slumpade lediga stol-id:n från den senaste läsningen (eller en tom lista).
 */
export function pickRandomAvailableSeats(maxSeats, browseSeconds = 0) {
  const event = http.get(`${BASE_URL}/events/${EVENT_ID}`);
  if (event.status !== 200) {
    return [];
  }
  const venueId = event.json('venueId');
  const sectionsRes = http.get(`${BASE_URL}/venues/${venueId}/sections`);
  const sections = sectionsRes.status === 200 ? sectionsRes.json('sections') : [];
  if (sections.length === 0) {
    return [];
  }
  const section = sections[Math.floor(Math.random() * sections.length)];
  browseSection(section.id, browseSeconds);
  const available = readAvailableSeatIds(section.id);
  shuffleInPlace(available);
  return available.slice(0, maxSeats);
}

function seatStatusUrl(sectionId) {
  return `${BASE_URL}/events/${EVENT_ID}/sections/${sectionId}/seats/status`;
}

/**
 * Bara den sista läsningen tolkas, och då bara de lediga stolarnas id:n (gjson-filtret körs i Go, inte
 * som 5 000 JS-objekt). En sektion med 5 000 stolar är ca 790 KB; att tolka hela svaret varannan
 * sekund i tusentals VU:er fyllde lastgeneratorns minne (k6 "Killed" vid ca 1 200 VU).
 */
function readAvailableSeatIds(sectionId) {
  const res = http.get(seatStatusUrl(sectionId));
  if (res.status !== 200) {
    return [];
  }
  const ids = res.json('seats.#(status=="available")#.seatId');
  return Array.isArray(ids) ? ids : [];
}

/** Pollningen laddas ner som webbappens (samma trafik mot Cloudflare och klustret) men sparas inte. */
function browseSection(sectionId, browseSeconds) {
  const discard = { responseType: 'none' };
  for (let elapsed = 0; elapsed < browseSeconds; elapsed += SEAT_STATUS_POLL_SECONDS) {
    if (elapsed % SECTION_SUMMARY_POLL_SECONDS === 0) {
      http.get(`${BASE_URL}/events/${EVENT_ID}/sections/summary`, discard);
    }
    http.get(seatStatusUrl(sectionId), discard);
    sleep(SEAT_STATUS_POLL_SECONDS);
  }
}

function shuffleInPlace(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

/** Allt-eller-inget-reservationen (docs/plan.md "Concurrency-kärnan"). Ett 409 är ett FÖRVÄNTAT utfall (stolen hann tas), inte ett testfel. */
export function reserveSeats(token, seatIds) {
  if (seatIds.length === 0) {
    return undefined;
  }
  const res = http.post(
    `${BASE_URL}/events/${EVENT_ID}/reservations`,
    JSON.stringify({ seatIds }),
    {
      headers: {
        ...JSON_HEADERS,
        [QUEUE_TOKEN_HEADER]: token,
        'Idempotency-Key': randomUuid(),
      },
    },
  );
  check(res, {
    'reservations: 201 or 409 (seat already taken)': (r) =>
      r.status === 201 || r.status === 409,
  });
  return res.status === 201 ? res.json('reservationId') : undefined;
}

/** Initierar betalningen (docs/plan.md "Betalning") — väntar INTE in webhooken, se tests/load/README.md. */
export function checkout(token, reservationId) {
  const res = http.post(
    `${BASE_URL}/events/${EVENT_ID}/reservations/${reservationId}/checkout`,
    null,
    {
      headers: {
        [QUEUE_TOKEN_HEADER]: token,
        Authorization: `Bearer ${randomAuthToken()}`,
        'Idempotency-Key': randomUuid(),
      },
    },
  );
  check(res, { 'checkout: 201': (r) => r.status === 201 });
  return res.status === 201;
}

// Hur länge en besökare tittar på kartan innan hen reserverar (sekunder, slumpat inom intervallet).
const BROWSE_SECONDS_MIN = 4;
const BROWSE_SECONDS_MAX = 12;

/** En hel VU-iteration: väntrum → karta → reservation → betalning. Returnerar `true` bara om hela kedjan lyckades. */
export function runFullBookingAttempt(maxWaitSeconds, maxSeats) {
  const token = joinQueue();
  if (token === undefined) {
    return false;
  }
  if (!waitForAdmissionViaWebSocket(token, maxWaitSeconds)) {
    return false;
  }
  const browseSeconds =
    BROWSE_SECONDS_MIN +
    Math.floor(Math.random() * (BROWSE_SECONDS_MAX - BROWSE_SECONDS_MIN + 1));
  const seatIds = pickRandomAvailableSeats(maxSeats, browseSeconds);
  const reservationId = reserveSeats(token, seatIds);
  if (reservationId === undefined) {
    return false;
  }
  return checkout(token, reservationId);
}

function randomUuid() {
  // k6:s JS-runtime (goja) saknar crypto.randomUUID — räcker gott för
  // en Idempotency-Key som bara behöver vara unik per försök, inte
  // kryptografiskt oförutsägbar.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
