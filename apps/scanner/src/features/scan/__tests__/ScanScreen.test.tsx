/** Enhetstest för ScanScreen (scannern, docs/plan.md 7.8). */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanEvent } from '../../../lib/api-client.js';
import { ScanScreen } from '../ScanScreen.js';

const { postScan, decodeCallbacks, ApiError } = vi.hoisted(() => ({
  postScan: vi.fn(),
  ApiError: class extends Error {
    constructor(readonly status: number) {
      super('api');
    }
  },
  decodeCallbacks: [] as ((text: string) => void)[],
}));
vi.mock('../../../lib/api-client.js', () => ({ postScan, ApiError }));
vi.mock('../use-qr-scanner.js', () => ({
  useQrScanner: (onDecode: (text: string) => void) => {
    decodeCallbacks.push(onDecode);
    return { videoRef: { current: null }, cameraState: 'ready' };
  },
}));

const EVENT: ScanEvent = {
  id: 'e1',
  title: 'Neon Rivers',
  startsAt: '2026-11-27T19:00:00Z',
  venueName: 'Arenan',
  venueCity: 'Stockholm',
};
const OK = { result: 'ok', sectionName: 'Parkett', row: 'C', number: 12 };

function decode(text: string): Promise<void> {
  return act(async () => {
    decodeCallbacks.at(-1)?.(text);
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  postScan.mockReset();
  render(
    <ScanScreen
      event={EVENT}
      gate="Grind A"
      getAccessToken={() => Promise.resolve('token')}
      onChangeSetup={vi.fn()}
    />,
  );
});
afterEach(() => vi.useRealTimers());

describe('ScanScreen', () => {
  it('skickar koden med event, grind och token, visar resultatet och går tillbaka efter 2,5 s', async () => {
    postScan.mockResolvedValue(OK);
    await decode('a'.repeat(64));

    expect(postScan).toHaveBeenCalledWith('token', {
      eventId: 'e1',
      qrToken: 'a'.repeat(64),
      gate: 'Grind A',
    });
    expect(screen.getByRole('heading', { name: 'Giltig biljett' })).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(2500));
    expect(screen.queryByRole('heading', { name: 'Giltig biljett' })).toBeNull();
  });

  it('skannar inte om samma kod inom 3 s, men gör det efteråt', async () => {
    postScan.mockResolvedValue(OK);
    await decode('b'.repeat(64));
    await act(() => vi.advanceTimersByTimeAsync(2500));

    // Fönstret räknas från att kameran är tillbaka (resultatet har stängts).
    await act(() => vi.advanceTimersByTimeAsync(2900));
    await decode('b'.repeat(64));
    expect(postScan).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(200));
    await decode('b'.repeat(64));
    expect(postScan).toHaveBeenCalledTimes(2);
  });

  it('ignorerar avläsningar medan ett resultat visas', async () => {
    postScan.mockResolvedValue(OK);
    await decode('c'.repeat(64));
    await decode('d'.repeat(64));
    expect(postScan).toHaveBeenCalledTimes(1);
  });

  it('säger att inloggningen inte gäller när servern svarar 401', async () => {
    postScan.mockRejectedValueOnce(new ApiError(401));
    await decode('f'.repeat(64));
    expect(
      screen.getByRole('heading', { name: 'Inloggningen gäller inte längre' }),
    ).toBeInTheDocument();
  });

  it('visar ett fel och låter samma kod skannas om direkt efteråt', async () => {
    postScan.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(OK);
    await decode('e'.repeat(64));
    expect(screen.getByText('Kunde inte kontrollera')).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(2500));
    await decode('e'.repeat(64));
    expect(postScan).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading', { name: 'Giltig biljett' })).toBeInTheDocument();
  });
});
