import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api-client.js';
import { retryWhileBusy } from '../retry-while-busy.js';

const busy = () => new ApiError('The service is busy, try again', 503, 'SERVICE_UNAVAILABLE');
const noWait = () => Promise.resolve();

describe('retryWhileBusy', () => {
  it('försöker igen efter 503 och returnerar svaret när det lyckas', async () => {
    const run = vi.fn().mockRejectedValueOnce(busy()).mockResolvedValueOnce('token');

    await expect(retryWhileBusy(run, { sleep: noWait })).resolves.toBe('token');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('ger upp efter det sista försöket och kastar 503:an', async () => {
    const run = vi.fn().mockRejectedValue(busy());

    await expect(retryWhileBusy(run, { attempts: 3, sleep: noWait })).rejects.toMatchObject({
      status: 503,
    });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('försöker inte igen på andra fel', async () => {
    const closed = new ApiError('Sales closed', 410, 'SALES_CLOSED');
    const run = vi.fn().mockRejectedValue(closed);

    await expect(retryWhileBusy(run, { sleep: noWait })).rejects.toBe(closed);
    expect(run).toHaveBeenCalledOnce();
  });

  it('slutar när anroparen inte längre bryr sig', async () => {
    const run = vi.fn().mockRejectedValue(busy());

    await expect(
      retryWhileBusy(run, { sleep: noWait, isCancelled: () => true }),
    ).rejects.toMatchObject({ status: 503 });
    expect(run).toHaveBeenCalledOnce();
  });

  it('skickar inget nytt försök när anroparen slutade bry sig under väntan', async () => {
    let isCancelled = false;
    const sleep = () => {
      isCancelled = true;
      return Promise.resolve();
    };
    const run = vi.fn().mockRejectedValueOnce(busy()).mockResolvedValueOnce('ok');

    await expect(
      retryWhileBusy(run, { sleep, isCancelled: () => isCancelled }),
    ).rejects.toMatchObject({ status: 503 });
    expect(run).toHaveBeenCalledOnce();
  });

  it('väntar längre för varje försök', async () => {
    const delays: number[] = [];
    const sleep = (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    };
    const run = vi
      .fn()
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockResolvedValueOnce('ok');

    await retryWhileBusy(run, { baseDelayMs: 1000, sleep });

    const [first = 0, second = 0] = delays;
    expect(first).toBeGreaterThanOrEqual(1000);
    expect(first).toBeLessThan(2000);
    expect(second).toBeGreaterThanOrEqual(2000);
    expect(second).toBeLessThan(3000);
  });
});
