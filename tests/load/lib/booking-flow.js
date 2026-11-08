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
// Med socket: fast 15 s. Webbappen tar max(15 s, nextPollSeconds), så skriptet belastar här något MER än
// riktiga besökare när servern ber om längre; k6:s socket.setInterval kan inte ändra takt i farten.
const QUEUE_FALLBACK_POLL_SECONDS = 15;
// Utan socket: serverns `nextPollSeconds`, aldrig tätare än 5 s, ±20 % spridning (som webbappen).
const QUEUE_MIN_POLL_SECONDS = 5;
const QUEUE_POLL_JITTER = 0.2;
const SEAT_STATUS_POLL_SECONDS = 2;
const SECTION_SUMMARY_POLL_SECONDS = 10;
const QUEUE_END_TYPES = new Set(['sales_closed', 'sold_out']);

/**
 * En statusläsning: `state` är 'admitted', 'closed' (stängt eller slutsålt) eller 'waiting', och
 * `nextPollSeconds` serverns besked om när det är lönt att fråga igen. Ett tillfälligt fel (429, 5xx,
 * ett Cloudflare-svar) räknas som 'waiting', precis som webbappen fortsätter vänta.
 */
function readQueueStatus(token) {
  const res = http.get(`${BASE_URL}/events/${EVENT_ID}/queue/status`, {
    headers: { [QUEUE_TOKEN_HEADER]: token },
  });
  if (res.status !== 200) {
    return { state: 'waiting', nextPollSeconds: undefined };
  }
  const status = res.json('status');
  const nextPollSeconds = res.json('nextPollSeconds');
  if (status === 'admitted') {
    return { state: 'admitted', nextPollSeconds };
  }
  return { state: QUEUE_END_TYPES.has(status) ? 'closed' : 'waiting', nextPollSeconds };
}

function noSocketPollDelaySeconds(nextPollSeconds) {
  const base = Math.max(
    QUEUE_MIN_POLL_SECONDS,
    typeof nextPollSeconds === 'number' ? nextPollSeconds : 0,
  );
  return base * (1 - QUEUE_POLL_JITTER + Math.random() * 2 * QUEUE_POLL_JITTER);
}

/**
 * Väntar på insläpp som webbappen gör: först en statusläsning (direktinsläppet skickar inget
 * WebSocket-meddelande), sedan WebSocket mot realtime-gateway, med en statusläsning var 15:e
 * sekund som reserv. Stängs socketen i förtid (uppgraderingen misslyckas, servern eller Cloudflare
 * stänger) pollas status i serverns takt, aldrig tätare än var 5:e sekund, som webbappen gör utan socket.
 * Returnerar `true`/`false`, aldrig ett fel: att INTE bli insläppt inom fönstret är ett giltigt,
 * mätbart utfall.
 *
 * Skickar tokenet som FÖRSTA meddelandet, aldrig i URL:en, samma regel som
 * services/realtime-gateway/src/controllers/ws-controller.ts.
 */
export function waitForAdmissionViaWebSocket(token, maxWaitSeconds) {
  const deadline = Date.now() + maxWaitSeconds * 1000;
  const first = readQueueStatus(token);
  if (first.state !== 'waiting') {
    return first.state === 'admitted';
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
      const { state } = readQueueStatus(token);
      if (state === 'admitted' || state === 'closed') {
        admitted = state === 'admitted';
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
    const { state, nextPollSeconds } = readQueueStatus(token);
    if (state !== 'waiting') {
      return state === 'admitted';
    }
    sleep(noSocketPollDelaySeconds(nextPollSeconds));
  }
  return false;
}

/**
 * Upptäcker lediga stolar precis som den riktiga klienten gör (karta → sektion → stolsstatus), INTE en
 * genväg direkt mot databasen. Som webbappen (apps/web/src/lib/seat-status.ts) hämtas sektionens katalog
 * (stolarnas id och pris) en gång när sektionen öppnas, och sedan bara den kompakta statusen (ett tecken
 * per stol) varannan sekund under `browseSeconds`, plus sektionssammanfattningen var 10:e sekund. Genom
 * Cloudflare cachas stolsstatusen vid kanten, sammanfattningen inte (docs/loadtest-cpu-plan.md steg 6).
 * Returnerar upp till `maxSeats` slumpade lediga stol-id:n från den senaste läsningen (eller en tom lista).
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
  const catalog = readSeatCatalog(section.id);
  browseSection(section.id, browseSeconds);
  const available = readAvailableSeatIds(section.id, catalog);
  shuffleInPlace(available);
  return available.slice(0, maxSeats);
}

function seatStatusUrl(sectionId, view) {
  return `${BASE_URL}/events/${EVENT_ID}/sections/${sectionId}/seats/status?view=${view}`;
}

/**
 * Som webbappen: statusen först, sedan katalogen för just den versionen (`&version=`). Returnerar
 * katalogens version och stol-id:n i katalogens ordning (gjson-urvalet körs i Go, inte som JS-objekt).
 */
function readSeatCatalog(sectionId) {
  const compact = http.get(seatStatusUrl(sectionId, 'compact'));
  if (compact.status !== 200) {
    return undefined;
  }
  const version = compact.json('version');
  const res = http.get(`${seatStatusUrl(sectionId, 'catalog')}&version=${version}`);
  if (res.status !== 200) {
    return undefined;
  }
  const seatIds = res.json('seats.#.seatId');
  return Array.isArray(seatIds) ? { version: res.json('version'), seatIds } : undefined;
}

/**
 * Den sista statusläsningen tolkas: stolar vars tecken är `a` (ledig) på samma position som i katalogen.
 * Stämmer inte versionen (stolar har ändrats) väljs inget, precis som webbappen hellre hämtar om än gissar.
 */
function readAvailableSeatIds(sectionId, catalog) {
  if (catalog === undefined) {
    return [];
  }
  const res = http.get(seatStatusUrl(sectionId, 'compact'));
  if (res.status !== 200 || res.json('version') !== catalog.version) {
    return [];
  }
  const statuses = res.json('statuses');
  if (typeof statuses !== 'string' || statuses.length !== catalog.seatIds.length) {
    return [];
  }
  return catalog.seatIds.filter((_, index) => statuses.charAt(index) === 'a');
}

/** Pollningen laddas ner som webbappens (samma trafik mot Cloudflare och klustret) men sparas inte. */
function browseSection(sectionId, browseSeconds) {
  const discard = { responseType: 'none' };
  for (let elapsed = 0; elapsed < browseSeconds; elapsed += SEAT_STATUS_POLL_SECONDS) {
    if (elapsed % SECTION_SUMMARY_POLL_SECONDS === 0) {
      http.get(`${BASE_URL}/events/${EVENT_ID}/sections/summary`, discard);
    }
    http.get(seatStatusUrl(sectionId, 'compact'), discard);
    sleep(SEAT_STATUS_POLL_SECONDS);
  }
}

function shuffleInPlace(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

// Som webbappen (apps/web/src/lib/retry-while-busy.ts): 503 betyder "upptaget, försök igen".
const BUSY_ATTEMPTS = 5;
const BUSY_BASE_DELAY_SECONDS = 1;
// 409 som är väntade utfall. IDEMPOTENCY_CONFLICT är det inte: då fastnade nyckeln efter ett 503.
const EXPECTED_CONFLICTS = new Set(['SEAT_UNAVAILABLE', 'ACTIVE_RESERVATION_EXISTS']);

/**
 * Allt-eller-inget-reservationen (docs/plan.md "Concurrency-kärnan"). Ett 409 för en tagen stol är ett
 * FÖRVÄNTAT utfall, inte ett testfel. 503 försöks om med SAMMA Idempotency-Key, som webbappen gör.
 */
export function reserveSeats(token, seatIds) {
  if (seatIds.length === 0) {
    return undefined;
  }
  const idempotencyKey = randomUuid();
  let res;
  for (let attempt = 1; attempt <= BUSY_ATTEMPTS; attempt += 1) {
    res = http.post(
      `${BASE_URL}/events/${EVENT_ID}/reservations`,
      JSON.stringify({ seatIds }),
      {
        headers: {
          ...JSON_HEADERS,
          [QUEUE_TOKEN_HEADER]: token,
          'Idempotency-Key': idempotencyKey,
        },
      },
    );
    if (res.status !== 503 || attempt === BUSY_ATTEMPTS) {
      break;
    }
    sleep(BUSY_BASE_DELAY_SECONDS * attempt + Math.random() * BUSY_BASE_DELAY_SECONDS);
  }
  check(res, {
    'reservations: 201 or 409 (seat already taken)': (r) =>
      r.status === 201 || (r.status === 409 && EXPECTED_CONFLICTS.has(r.json('error.code'))),
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
