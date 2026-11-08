import { createLogger } from '@tickets/observability';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deliverAndLog,
  WEBHOOK_DELIVERY_ATTEMPTS,
  type WebhookDeliveryDeps,
} from '../../src/services/webhook-delivery-service.js';

const deps: WebhookDeliveryDeps = {
  webhookUrl: 'http://booking-api.test/webhooks/stripe',
  webhookSecret: 'secret',
  chaosConfig: {
    latencyMinMs: 0,
    latencyMaxMs: 0,
    failureRate: 0,
    duplicateWebhookRate: 0,
    lateWebhookRate: 0,
    lateWebhookDelayMs: 0,
  },
  logger: createLogger({ serviceName: 'test' }),
};

function stubFetch(...statuses: number[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const status of statuses) {
    fetchMock.mockResolvedValueOnce(new Response(null, { status }));
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('deliverAndLog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('levererar igen efter ett svar som inte är 2xx och slutar när det lyckas', async () => {
    const fetchMock = stubFetch(409, 200);

    deliverAndLog(deps, '{}', 'primary');
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ger upp efter sista försöket', async () => {
    const fetchMock = stubFetch(...Array<number>(WEBHOOK_DELIVERY_ATTEMPTS + 2).fill(500));

    deliverAndLog(deps, '{}', 'primary');
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(WEBHOOK_DELIVERY_ATTEMPTS);
  });

  it('levererar igen när anropet inte kom fram alls (nätverksfel)', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    deliverAndLog(deps, '{}', 'primary');
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('levererar bara en gång när första svaret är 2xx', async () => {
    const fetchMock = stubFetch(200);

    deliverAndLog(deps, '{}', 'primary');
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
