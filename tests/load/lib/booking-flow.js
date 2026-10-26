// Delade byggstenar för hela bokningsflödet (docs/plan.md "Domän och
// användarflöde"): väntrum → karta → reservation → betalning. Varje
// scenario-script komponerar dessa efter vad just DET scenariot mäter
// (queue-storm stannar vid väntrummet, normal-sale/spike-sale går hela
// vägen) — docs/rules.md §1-andan (dela det flera behöver), bara för
// k6-script istället för tjänstekod.
import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { randomAuthToken, BASE_URL, WS_BASE_URL, EVENT_ID } from './config.js';

const QUEUE_TOKEN_HEADER = 'X-Queue-Token';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function joinQueue() {
  const res = http.post(`${BASE_URL}/events/${EVENT_ID}/queue/join`);
  const ok = check(res, { 'queue/join: 201': (r) => r.status === 201 });
  return ok ? res.json('token') : undefined;
}

/**
 * Pollar statusendpointen var 2:a sekund (samma takt som den riktiga
 * PWA:n, docs/plan.md "Realtid") tills kötoken är insläppt eller
 * `maxWaitSeconds` passerat. Returnerar `true`/`false`, aldrig ett fel —
 * att INTE bli insläppt inom fönstret är ett giltigt, mätbart utfall
 * (queue-storm.js bryr sig bara om just detta).
 */
export function waitForAdmission(token, maxWaitSeconds) {
  const deadline = Date.now() + maxWaitSeconds * 1000;
  while (Date.now() < deadline) {
    const res = http.get(`${BASE_URL}/events/${EVENT_ID}/queue/status`, {
      headers: { [QUEUE_TOKEN_HEADER]: token },
    });
    if (res.status === 200 && res.json('status') === 'admitted') {
      return true;
    }
    sleep(2);
  }
  return false;
}

/**
 * Som waitForAdmission, men via WebSocket mot realtime-gateway i
 * stället för REST-polling (docs/plan.md "Realtid": köplats/insläpp är
 * just det WS används till). queue-storm.js:s hela poäng är att öva
 * Fas 6:s pub/sub-ombyggnad (en delad `psubscribe`-anslutning per podd)
 * och realtime-gatewayens HPA under riktiga 50 000 samtidiga
 * anslutningar — REST-polling övar ingenting av det (upptäckt i
 * Fas 6-reviewn). OVERIFIERAT mot en riktig k6-körning (ingen k6-binär
 * i byggmiljön) — smoke-testa med få VU innan den stora körningen.
 *
 * Skickar tokenet som FÖRSTA meddelandet, aldrig i URL:en, samma regel
 * som services/realtime-gateway/src/controllers/ws-controller.ts.
 */
export function waitForAdmissionViaWebSocket(token, maxWaitSeconds) {
  let admitted = false;
  const response = ws.connect(`${WS_BASE_URL}/ws`, {}, (socket) => {
    socket.on('open', () => socket.send(JSON.stringify({ token })));
    socket.on('message', (raw) => {
      const payload = JSON.parse(raw);
      if (payload.type === 'admitted') {
        admitted = true;
        socket.close();
      }
    });
    socket.setTimeout(() => socket.close(), maxWaitSeconds * 1000);
  });
  check(response, { 'ws: upgraded (101)': (r) => r && r.status === 101 });
  return admitted;
}

/**
 * Upptäcker lediga stolar precis som den riktiga klienten gör (karta →
 * sektion → stolsstatus), INTE en genväg direkt mot databasen — det är
 * precis den vägen som ska belastningstestas. Returnerar upp till
 * `maxSeats` slumpade, för tillfället lediga stol-id:n (eller en tom
 * lista om ingen sektion hade några — reserveSeats hanterar det som ett
 * giltigt "inga stolar valda"-utfall).
 */
export function pickRandomAvailableSeats(maxSeats) {
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
  const statusRes = http.get(
    `${BASE_URL}/events/${EVENT_ID}/sections/${section.id}/seats/status`,
  );
  if (statusRes.status !== 200) {
    return [];
  }
  const available = statusRes
    .json('seats')
    .filter((seat) => seat.status === 'available')
    .map((seat) => seat.seatId);
  shuffleInPlace(available);
  return available.slice(0, maxSeats);
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

/** En hel VU-iteration: väntrum → karta → reservation → betalning. Returnerar `true` bara om hela kedjan lyckades. */
export function runFullBookingAttempt(maxWaitSeconds, maxSeats) {
  const token = joinQueue();
  if (token === undefined) {
    return false;
  }
  if (!waitForAdmission(token, maxWaitSeconds)) {
    return false;
  }
  const seatIds = pickRandomAvailableSeats(maxSeats);
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
