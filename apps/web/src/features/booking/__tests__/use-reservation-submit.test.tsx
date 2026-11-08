import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api-client.js';
import { useReservationSubmit } from '../use-reservation-submit.js';

const { createReservation } = vi.hoisted(() => ({ createReservation: vi.fn() }));
vi.mock('../../../lib/api-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/api-client.js')>()),
  createReservation,
}));
vi.mock('../../../lib/analytics.js', () => ({ track: vi.fn() }));
vi.mock('../../analytics/use-event-context.js', () => ({ useEventContext: () => undefined }));

const busy = () => new ApiError('The service is busy, try again', 503, 'SERVICE_UNAVAILABLE');

function wrapper({ children }: { children: ReactNode }): ReactNode {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => createReservation.mockReset());

describe('useReservationSubmit', () => {
  it('försöker igen efter 503 med samma idempotensnyckel och lyckas utan felmeddelande', async () => {
    createReservation.mockRejectedValueOnce(busy()).mockResolvedValueOnce({
      reservationId: 'res-1',
    });
    const { result } = renderHook(() => useReservationSubmit('e1', 'queue-token', ['s1']), {
      wrapper,
    });

    act(() => result.current.reserve());

    await waitFor(() => expect(createReservation).toHaveBeenCalledTimes(2), { timeout: 4000 });
    const [first, second] = createReservation.mock.calls;
    expect(second?.[3]).toBe(first?.[3]);
    await waitFor(() => expect(result.current.isReserving).toBe(false));
    expect(result.current.errorMessage).toBeUndefined();
  });

  it('visar inte "platsen är tagen" när nyckeln fastnat efter ett 503', async () => {
    createReservation
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(new ApiError('conflict', 409, 'IDEMPOTENCY_CONFLICT'));
    const { result } = renderHook(() => useReservationSubmit('e1', 'queue-token', ['s1']), {
      wrapper,
    });

    act(() => result.current.reserve());

    await waitFor(() => expect(result.current.errorMessage).toMatch(/mycket tryck/), {
      timeout: 4000,
    });
    expect(createReservation).toHaveBeenCalledTimes(2);
  });

  it('försöker inte igen när platsen redan är tagen (409)', async () => {
    createReservation.mockRejectedValue(new ApiError('taken', 409, 'SEAT_UNAVAILABLE'));
    const { result } = renderHook(() => useReservationSubmit('e1', 'queue-token', ['s1']), {
      wrapper,
    });

    act(() => result.current.reserve());

    await waitFor(() => expect(result.current.errorMessage).toMatch(/hann bli upptagna/));
    expect(createReservation).toHaveBeenCalledOnce();
  });
});
