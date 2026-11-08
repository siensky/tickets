/**
 * Insläppet kommer över WebSocket: ett meddelande ger en omedelbar statusläsning, så sidan aldrig
 * litar på socketen ensam. När socketen är uppe pollas status bara var 15:e sekund som reserv; när den
 * inte är uppe följs serverns `nextPollSeconds`, aldrig tätare än var 5:e sekund, och varje
 * (åter)anslutning läser status direkt. Platskartan (redan insläppt) ansluter inte alls.
 */
import { act, screen, waitFor } from '@testing-library/react';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../lib/api-client.js';
import { renderWithProviders } from '../../test/render.js';
import { useQueueAdmission } from '../use-queue-admission.js';

interface FakeSocket {
  token: string | undefined;
  isOpen: boolean;
  onMessage: ((payload: unknown) => void) | undefined;
  onOpen: (() => void) | undefined;
}
const socket = vi.hoisted((): FakeSocket => ({
  token: undefined,
  isOpen: false,
  onMessage: undefined,
  onOpen: undefined,
}));
vi.mock('../use-queue-socket.js', () => ({
  useQueueSocket: (
    token: string | undefined,
    onMessage: (payload: unknown) => void,
    onOpen?: () => void,
  ): boolean => {
    socket.token = token;
    socket.onMessage = onMessage;
    socket.onOpen = onOpen;
    return socket.isOpen;
  },
}));
vi.mock('../../lib/queue-token-storage.js', () => ({
  getStoredQueueToken: () => 'queue-token',
  storeQueueToken: vi.fn(),
}));
vi.mock('../../lib/api-client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api-client.js')>();
  return { ...original, getQueueStatus: vi.fn() };
});

const WAITING = { status: 'waiting', position: 3, queueDepth: 10 } as const;

function Probe({ listen }: { listen?: boolean }): JSX.Element {
  const { status } = useQueueAdmission(
    'e1',
    listen === undefined ? undefined : { listenForAdmission: listen },
  );
  return <p>{status?.status ?? 'laddar'}</p>;
}

beforeEach(() => {
  socket.token = undefined;
  socket.isOpen = false;
  socket.onMessage = undefined;
  socket.onOpen = undefined;
  vi.mocked(api.getQueueStatus).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useQueueAdmission', () => {
  it('läser status direkt när insläppet kommer över WebSocket', async () => {
    socket.isOpen = true;
    vi.mocked(api.getQueueStatus)
      .mockResolvedValueOnce(WAITING)
      .mockResolvedValue({ status: 'admitted' });
    renderWithProviders(<Probe />);
    expect(await screen.findByText('waiting')).toBeInTheDocument();
    expect(socket.token).toBe('queue-token');

    socket.onMessage?.({ type: 'admitted' });

    expect(await screen.findByText('admitted')).toBeInTheDocument();
    expect(api.getQueueStatus).toHaveBeenCalledTimes(2);
  });

  it('läser status direkt när socketen öppnas, så att ett missat insläpp hittas', async () => {
    vi.mocked(api.getQueueStatus).mockResolvedValueOnce(WAITING).mockResolvedValue({
      status: 'admitted',
    });
    renderWithProviders(<Probe />);
    expect(await screen.findByText('waiting')).toBeInTheDocument();

    socket.onOpen?.();

    expect(await screen.findByText('admitted')).toBeInTheDocument();
  });

  it('bryr sig inte om andra meddelanden, som seat_taken', async () => {
    socket.isOpen = true;
    vi.mocked(api.getQueueStatus).mockResolvedValue(WAITING);
    renderWithProviders(<Probe />);
    expect(await screen.findByText('waiting')).toBeInTheDocument();

    socket.onMessage?.({ type: 'seat_taken', seatId: 's1' });

    await waitFor(() => expect(api.getQueueStatus).toHaveBeenCalledTimes(1));
  });
});

describe('useQueueAdmission: pollingintervall', () => {
  it('pollar aldrig oftare än var 5:e sekund utan socket, även när servern ber om tätare', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.getQueueStatus).mockResolvedValue({ ...WAITING, nextPollSeconds: 1 });
    renderWithProviders(<Probe />);
    expect(await screen.findByText('waiting')).toBeInTheDocument();

    // Golvet 5 s minus 20 % spridning: inget nytt anrop före 4 s, ett senast efter 6 s.
    await act(() => vi.advanceTimersByTimeAsync(3900));
    expect(api.getQueueStatus).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(2200));
    expect(api.getQueueStatus).toHaveBeenCalledTimes(2);
  });

  it('följer serverns längre intervall utan socket', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.getQueueStatus).mockResolvedValue({ ...WAITING, nextPollSeconds: 20 });
    renderWithProviders(<Probe />);
    expect(await screen.findByText('waiting')).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(15_900));
    expect(api.getQueueStatus).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(8200));
    expect(api.getQueueStatus).toHaveBeenCalledTimes(2);
  });

  it('pollar bara som sällsynt reserv med en öppen socket', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    socket.isOpen = true;
    vi.mocked(api.getQueueStatus).mockResolvedValue(WAITING);
    renderWithProviders(<Probe />);
    expect(await screen.findByText('waiting')).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(11_900));
    expect(api.getQueueStatus).toHaveBeenCalledTimes(1);
  });

  it('följer serverns längre intervall även med en öppen socket', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    socket.isOpen = true;
    vi.mocked(api.getQueueStatus).mockResolvedValue({ ...WAITING, nextPollSeconds: 30 });
    renderWithProviders(<Probe />);
    expect(await screen.findByText('waiting')).toBeInTheDocument();

    // 30 s minus 20 % spridning: inget nytt anrop före 24 s, trots reservens 15 s.
    await act(() => vi.advanceTimersByTimeAsync(23_900));
    expect(api.getQueueStatus).toHaveBeenCalledTimes(1);
  });

  it('ansluter inte när sidan redan är insläppt (platskartan)', async () => {
    vi.mocked(api.getQueueStatus).mockResolvedValue({ status: 'admitted' });
    renderWithProviders(<Probe listen={false} />);

    expect(await screen.findByText('admitted')).toBeInTheDocument();
    expect(socket.token).toBeUndefined();
  });
});
