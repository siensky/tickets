import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, listEvents } from '../api-client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: { status: number; body: unknown }): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    json: () => Promise.resolve(response.body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('listEvents', () => {
  it('returns the parsed body on a successful response', async () => {
    stubFetch({ status: 200, body: { events: [] } });

    await expect(listEvents()).resolves.toEqual({ events: [] });
  });

  it('throws an ApiError carrying the status and code on a failed response', async () => {
    stubFetch({
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: 'boom' } },
    });

    const error = await listEvents().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 500, code: 'INTERNAL_ERROR', message: 'boom' });
  });

  it('builds a query string for category and search filters (Fas 6)', async () => {
    const fetchMock = stubFetch({ status: 200, body: { events: [] } });

    await listEvents({ category: 'music', q: 'Coldplay' });

    const requestedUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(requestedUrl).toContain('/events?');
    expect(requestedUrl).toContain('category=music');
    expect(requestedUrl).toContain('q=Coldplay');
  });

  it('omits the query string entirely when no filter is given', async () => {
    const fetchMock = stubFetch({ status: 200, body: { events: [] } });

    await listEvents();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/events');
  });
});
