/**
 * Pact-konsumenttest: web → booking-api (docs/plan.md 7.9, kontrakt 1).
 * Anropen görs med den riktiga `api-client.ts` där en funktion finns. De nya
 * endpointsen (sektionssammanfattning, orderstatus) saknar klientfunktion
 * tills UI-steget (Fas 7 steg 7) utökar klienten, så de anropas med `fetch`
 * och kontraktet beskriver fälten UI:t kommer att läsa.
 *
 * Skriver `pacts/web-booking-api.json`. booking-api verifierar den i
 * services/booking-api/tests/contract. Providerns data styrs av `given(...)`.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Matchers, PactV4 } from '@pact-foundation/pact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_ID,
  ORDER_ID,
  RESERVATION_ID,
  SEAT_ID,
  SECTION_ID,
  UNKNOWN_ORDER_ID,
  VENUE_ID,
} from './ids.js';

const PACTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../pacts');
const { eachLike, uuid, integer, boolean, string, regex, nullValue } = Matchers;

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const iso = (example: string) => regex(ISO_DATETIME, example);
const STARTS_AT = '2026-12-05T18:30:00.000Z';
const QUEUE_TOKEN = 'queue-token';
const ACCESS_TOKEN = 'contract-user';

const pact = new PactV4({
  consumer: 'web',
  provider: 'booking-api',
  dir: PACTS_DIR,
  logLevel: 'warn',
});

type ApiClient = typeof import('../../src/lib/api-client.js');
let client: ApiClient;

async function loadClient(baseUrl: string): Promise<ApiClient> {
  vi.stubEnv('VITE_API_BASE_URL', baseUrl);
  vi.resetModules();
  return import('../../src/lib/api-client.js');
}

const eventShape = (imageUrl: unknown) => ({
  id: uuid(EVENT_ID),
  title: string('Neon Rivers'),
  artist: string('Neon Rivers'),
  category: string('music'),
  venueId: uuid(VENUE_ID),
  venueName: string('Systemtestarenan'),
  venueCity: string('Testby'),
  startsAt: iso(STARTS_AT),
  salesOpenAt: iso(STARTS_AT),
  salesCloseAt: iso(STARTS_AT),
  status: string('scheduled'),
  isBeforeOpen: boolean(false),
  isAfterClose: boolean(false),
  imageUrl,
  description: string('Beskrivning'),
  featured: boolean(true),
  minPriceCents: integer(39_500),
  maxPriceCents: integer(69_500),
  availableSeats: integer(1),
  totalSeats: integer(1),
  availability: regex(/^(closed|opens_soon|sold_out|few_left|on_sale)$/, 'few_left'),
});

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe('web → booking-api', () => {
  it('GET /events listar events med presentationsfälten', async () => {
    await pact
      .addInteraction()
      .given('an event with an image exists')
      .uponReceiving('a request to list events')
      .withRequest('GET', '/events')
      .willRespondWith(200, (b) => {
        b.jsonBody({
          events: eachLike(eventShape(string('https://cdn.example.test/images/neon.webp'))),
        });
      })
      .executeTest(async (mockServer) => {
        client = await loadClient(mockServer.url);
        const { events } = await client.listEvents();
        expect(events[0]?.id).toBe(EVENT_ID);
      });
  });

  it('GET /events/:eventId ger imageUrl null när eventet saknar bild', async () => {
    await pact
      .addInteraction()
      .given('an event without an image exists')
      .uponReceiving('a request for an event without an image')
      .withRequest('GET', `/events/${EVENT_ID}`)
      .willRespondWith(200, (b) => {
        b.jsonBody({
          ...eventShape(nullValue()),
          description: nullValue(),
          featured: boolean(false),
        });
      })
      .executeTest(async (mockServer) => {
        client = await loadClient(mockServer.url);
        const event = await client.getEvent(EVENT_ID);
        expect(event.id).toBe(EVENT_ID);
      });
  });

  it('GET /events/:eventId ger 404 för ett okänt event', async () => {
    await pact
      .addInteraction()
      .given('no event exists')
      .uponReceiving('a request for an unknown event')
      .withRequest('GET', `/events/${EVENT_ID}`)
      .willRespondWith(404)
      .executeTest(async (mockServer) => {
        client = await loadClient(mockServer.url);
        await expect(client.getEvent(EVENT_ID)).rejects.toMatchObject({ status: 404 });
      });
  });

  it('GET /events/:eventId/sections/summary ger sektioner med layout och tillgänglighet', async () => {
    await pact
      .addInteraction()
      .given('an event with a laid-out section exists')
      .uponReceiving('a request for the section summary')
      .withRequest('GET', `/events/${EVENT_ID}/sections/summary`)
      .willRespondWith(200, (b) => {
        b.jsonBody({
          stage: { x: integer(350), y: integer(20), width: integer(300), height: integer(60) },
          sections: eachLike({
            id: uuid(SECTION_ID),
            name: string('Parkett'),
            displayOrder: integer(1),
            layout: {
              x: integer(100),
              y: integer(200),
              width: integer(300),
              height: integer(150),
              rotation: integer(0),
            },
            availableCount: integer(1),
            totalCount: integer(1),
            minPriceCents: integer(39_500),
            maxPriceCents: integer(39_500),
            availability: regex(/^(sold_out|few_left|on_sale)$/, 'few_left'),
          }),
        });
      })
      .executeTest(async (mockServer) => {
        const response = await fetch(`${mockServer.url}/events/${EVENT_ID}/sections/summary`);
        expect(response.status).toBe(200);
      });
  });

  it('GET stolstatus bär pris per stol', async () => {
    await pact
      .addInteraction()
      .given('an event with an available seat exists')
      .uponReceiving('a request for the seat status of a section')
      .withRequest('GET', `/events/${EVENT_ID}/sections/${SECTION_ID}/seats/status`)
      .willRespondWith(200, (b) => {
        b.jsonBody({
          seats: eachLike({
            seatId: uuid(SEAT_ID),
            venueSeatId: uuid(),
            status: regex(/^(available|held|sold)$/, 'available'),
            priceCents: integer(39_500),
          }),
        });
      })
      .executeTest(async (mockServer) => {
        client = await loadClient(mockServer.url);
        const { seats } = await client.getSectionSeatStatus(EVENT_ID, SECTION_ID);
        expect(seats[0]?.seatId).toBe(SEAT_ID);
      });
  });

  it('POST /events/:eventId/reservations skapar en reservation', async () => {
    await pact
      .addInteraction()
      .given('the queue token is admitted and the seat is available')
      .uponReceiving('a request to reserve a seat')
      .withRequest('POST', `/events/${EVENT_ID}/reservations`, (b) => {
        b.headers({
          'x-queue-token': QUEUE_TOKEN,
          'idempotency-key': 'idem-reserve-1',
          'content-type': 'application/json',
        }).jsonBody({ seatIds: [SEAT_ID] });
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          reservationId: uuid(RESERVATION_ID),
          eventId: uuid(EVENT_ID),
          seatIds: [SEAT_ID],
          status: 'active',
          expiresAt: iso('2026-12-05T18:35:00.000Z'),
        });
      })
      .executeTest(async (mockServer) => {
        client = await loadClient(mockServer.url);
        const reservation = await client.createReservation(
          EVENT_ID,
          QUEUE_TOKEN,
          [SEAT_ID],
          'idem-reserve-1',
        );
        expect(reservation.status).toBe('active');
      });
  });

  it('GET reservationen ger stolar och serverns summa', async () => {
    await pact
      .addInteraction()
      .given('an active reservation with one seat exists')
      .uponReceiving('a request for the reservation')
      .withRequest('GET', `/events/${EVENT_ID}/reservations/${RESERVATION_ID}`, (b) => {
        b.headers({ 'x-queue-token': QUEUE_TOKEN });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          reservationId: uuid(RESERVATION_ID),
          eventId: uuid(EVENT_ID),
          status: 'active',
          expiresAt: iso('2026-12-05T18:35:00.000Z'),
          seatIds: [SEAT_ID],
          seats: eachLike({
            seatId: uuid(SEAT_ID),
            sectionId: uuid(SECTION_ID),
            sectionName: string('Parkett'),
            row: string('A'),
            number: integer(1),
            priceCents: integer(39_500),
          }),
          totalCents: integer(39_500),
          currency: 'SEK',
        });
      })
      .executeTest(async (mockServer) => {
        client = await loadClient(mockServer.url);
        const reservation = await client.getReservation(EVENT_ID, RESERVATION_ID, QUEUE_TOKEN);
        expect(reservation.status).toBe('active');
      });
  });

  it('POST checkout ger orderId och checkoutUrl', async () => {
    await pact
      .addInteraction()
      .given('an active reservation with one seat exists')
      .uponReceiving('a request to start checkout')
      .withRequest(
        'POST',
        `/events/${EVENT_ID}/reservations/${RESERVATION_ID}/checkout`,
        (b) => {
          b.headers({
            'x-queue-token': QUEUE_TOKEN,
            authorization: `Bearer ${ACCESS_TOKEN}`,
            'idempotency-key': 'idem-checkout-1',
          });
        },
      )
      .willRespondWith(201, (b) => {
        b.jsonBody({
          orderId: uuid(ORDER_ID),
          checkoutUrl: string('https://checkout.test/cs_1'),
        });
      })
      .executeTest(async (mockServer) => {
        client = await loadClient(mockServer.url);
        const result = await client.createCheckout(
          EVENT_ID,
          RESERVATION_ID,
          QUEUE_TOKEN,
          ACCESS_TOKEN,
          'idem-checkout-1',
        );
        expect(result.orderId).toBe(ORDER_ID);
      });
  });

  it('GET orderstatus ger status och antal biljetter för den egna ordern', async () => {
    await pact
      .addInteraction()
      .given('a paid order with one ticket exists for the user')
      .uponReceiving('a request for the order status')
      .withRequest('GET', `/events/${EVENT_ID}/orders/${ORDER_ID}`, (b) => {
        b.headers({ authorization: `Bearer ${ACCESS_TOKEN}` });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          orderId: uuid(ORDER_ID),
          eventId: uuid(EVENT_ID),
          status: regex(/^(pending|paid|refunded|cancelled)$/, 'paid'),
          totalCents: integer(39_500),
          ticketCount: integer(1),
        });
      })
      .executeTest(async (mockServer) => {
        const response = await fetch(
          `${mockServer.url}/events/${EVENT_ID}/orders/${ORDER_ID}`,
          {
            headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
          },
        );
        expect(response.status).toBe(200);
      });
  });

  it('GET orderstatus ger 404 för en order som inte finns eller inte är användarens', async () => {
    await pact
      .addInteraction()
      .given('a paid order with one ticket exists for the user')
      .uponReceiving('a request for an order that does not exist')
      .withRequest('GET', `/events/${EVENT_ID}/orders/${UNKNOWN_ORDER_ID}`, (b) => {
        b.headers({ authorization: `Bearer ${ACCESS_TOKEN}` });
      })
      .willRespondWith(404)
      .executeTest(async (mockServer) => {
        const response = await fetch(
          `${mockServer.url}/events/${EVENT_ID}/orders/${UNKNOWN_ORDER_ID}`,
          { headers: { authorization: `Bearer ${ACCESS_TOKEN}` } },
        );
        expect(response.status).toBe(404);
      });
  });

  it('GET /me/tickets ger ordrar med biljetter, event- och sektionsinfo', async () => {
    await pact
      .addInteraction()
      .given('a paid order with one ticket exists for the user')
      .uponReceiving('a request for my tickets')
      .withRequest('GET', '/me/tickets', (b) => {
        b.headers({ authorization: `Bearer ${ACCESS_TOKEN}` });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          orders: eachLike({
            orderId: uuid(ORDER_ID),
            eventId: uuid(EVENT_ID),
            eventTitle: string('Neon Rivers'),
            eventStartsAt: iso(STARTS_AT),
            venueName: string('Systemtestarenan'),
            venueCity: string('Testby'),
            status: string('paid'),
            totalCents: integer(39_500),
            createdAt: iso('2026-10-29T12:00:00.000Z'),
            tickets: eachLike({
              ticketId: uuid(),
              seatId: uuid(SEAT_ID),
              sectionId: uuid(SECTION_ID),
              sectionName: string('Parkett'),
              row: string('A'),
              number: integer(1),
              status: string('valid'),
              qrToken: string('qr-token'),
            }),
          }),
        });
      })
      .executeTest(async (mockServer) => {
        client = await loadClient(mockServer.url);
        const { orders } = await client.listMyTickets(ACCESS_TOKEN);
        expect(orders[0]?.orderId).toBe(ORDER_ID);
      });
  });
});
