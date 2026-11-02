/**
 * Skickar avlästa koder till `POST /scans` (docs/plan.md 7.8). En i taget: avläsningar medan ett
 * anrop pågår eller ett resultat visas ignoreras, och samma kod skickas inte om inom 3 s.
 * Resultatet visas i 2,5 s. Ett fel visas också och låter samma kod skannas om direkt.
 */
import { useRef, useState } from 'react';
import { RESULT_DISPLAY_MS, SCAN_DEBOUNCE_MS } from '../../config.js';
import { ApiError, postScan, type ScanEvent } from '../../lib/api-client.js';
import { createScanDebouncer } from '../../lib/scan-debounce.js';
import type { ScanDisplay } from './ScanResultOverlay.js';

export function useScanSubmission(
  event: ScanEvent,
  gate: string,
  getAccessToken: () => Promise<string>,
): { display: ScanDisplay | undefined; handleDecode: (qrToken: string) => Promise<void> } {
  const [display, setDisplay] = useState<ScanDisplay | undefined>();
  const isBusy = useRef(false);
  const debouncer = useRef(createScanDebouncer(SCAN_DEBOUNCE_MS));

  function showResult(next: ScanDisplay, qrToken: string | undefined): void {
    setDisplay(next);
    setTimeout(() => {
      setDisplay(undefined);
      isBusy.current = false;
      // Debounce-fönstret räknas från att kameran är tillbaka, inte från avläsningen: annars
      // skannas en biljett som hålls kvar om nästan direkt när resultatet stängs.
      if (qrToken !== undefined) {
        debouncer.current.reset();
        debouncer.current.accept(qrToken, Date.now());
      }
    }, RESULT_DISPLAY_MS);
  }

  async function handleDecode(qrToken: string): Promise<void> {
    if (isBusy.current || !debouncer.current.accept(qrToken, Date.now())) {
      return;
    }
    isBusy.current = true;
    try {
      const response = await postScan(await getAccessToken(), {
        eventId: event.id,
        qrToken,
        gate,
      });
      showResult(response, qrToken);
    } catch (error) {
      // Fel: visa det och låt samma kod kunna skannas om direkt.
      debouncer.current.reset();
      const isAuthProblem =
        error instanceof ApiError && (error.status === 401 || error.status === 403);
      showResult({ result: isAuthProblem ? 'auth' : 'error' }, undefined);
    }
  }

  return { display, handleDecode };
}
