/**
 * Pact-konsumenttest: scanner → booking-api (docs/plan.md 7.9, kontrakt 2): `POST /scans`.
 * Anropen görs med scannerns riktiga `api-client.ts`. Skriver `pacts/scanner-booking-api.json`,
 * som booking-api verifierar i services/booking-api/tests/contract.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Matchers, PactV4 } from '@pact-foundation/pact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENT_ID, SCAN_QR_TOKEN } from './ids.js';

const PACTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../pacts');
const { integer, regex, string } = Matchers;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const STAFF_TOKEN = 'contract-staff';
const SCAN_BODY = { eventId: EVENT_ID, qrToken: SCAN_QR_TOKEN, gate: 'Grind A' };

const pact = new PactV4({
  consumer: 'scanner',
  provider: 'booking-api',
  dir: PACTS_DIR,
  logLevel: 'warn',
});

async function loadClient(
  baseUrl: string,
): Promise<typeof import('../../src/lib/api-client.js')> {
  vi.stubEnv('VITE_API_BASE_URL', baseUrl);
  vi.resetModules();
  return import('../../src/lib/api-client.js');
}

const JSON_HEADERS = { 'content-type': 'application/json' };

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe('scanner → booking-api', () => {
  it('POST /scans godkänner en giltig biljett', async () => {
    await pact
      .addInteraction()
      .given('a valid ticket exists for scanning')
      .uponReceiving('a scan of a valid ticket')
      .withRequest('POST', '/scans', (b) => {
        b.headers({ ...JSON_HEADERS, authorization: `Bearer ${STAFF_TOKEN}` }).jsonBody(
          SCAN_BODY,
        );
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          result: 'ok',
          sectionName: string('Parkett'),
          row: string('A'),
          number: integer(1),
        });
      })
      .executeTest(async (mockServer) => {
        const client = await loadClient(mockServer.url);
        await expect(client.postScan(STAFF_TOKEN, SCAN_BODY)).resolves.toMatchObject({
          result: 'ok',
        });
      });
  });

  it('POST /scans ger already_scanned med tid och grind för en redan skannad biljett', async () => {
    await pact
      .addInteraction()
      .given('an already scanned ticket exists')
      .uponReceiving('a scan of an already scanned ticket')
      .withRequest('POST', '/scans', (b) => {
        b.headers({ ...JSON_HEADERS, authorization: `Bearer ${STAFF_TOKEN}` }).jsonBody(
          SCAN_BODY,
        );
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          result: 'already_scanned',
          scannedAt: regex(ISO_DATETIME, '2026-11-27T18:42:00.000Z'),
          gate: string('Grind A'),
        });
      })
      .executeTest(async (mockServer) => {
        const client = await loadClient(mockServer.url);
        await expect(client.postScan(STAFF_TOKEN, SCAN_BODY)).resolves.toMatchObject({
          result: 'already_scanned',
          gate: 'Grind A',
        });
      });
  });

  it('POST /scans ger not_found för en okänd biljett', async () => {
    await pact
      .addInteraction()
      .given('no event exists')
      .uponReceiving('a scan of an unknown ticket')
      .withRequest('POST', '/scans', (b) => {
        b.headers({ ...JSON_HEADERS, authorization: `Bearer ${STAFF_TOKEN}` }).jsonBody(
          SCAN_BODY,
        );
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ result: 'not_found' });
      })
      .executeTest(async (mockServer) => {
        const client = await loadClient(mockServer.url);
        await expect(client.postScan(STAFF_TOKEN, SCAN_BODY)).resolves.toEqual({
          result: 'not_found',
        });
      });
  });

  it('POST /scans ger 403 när tokenet saknar scan:tickets', async () => {
    await pact
      .addInteraction()
      .given('a valid ticket exists for scanning')
      .uponReceiving('a scan without the scan:tickets permission')
      .withRequest('POST', '/scans', (b) => {
        b.headers({ ...JSON_HEADERS, authorization: 'Bearer contract-user' }).jsonBody(
          SCAN_BODY,
        );
      })
      .willRespondWith(403)
      .executeTest(async (mockServer) => {
        const client = await loadClient(mockServer.url);
        await expect(client.postScan('contract-user', SCAN_BODY)).rejects.toMatchObject({
          status: 403,
        });
      });
  });
});
