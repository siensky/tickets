/**
 * Kameran och QR-läsningen (docs/plan.md 7.8): bakre kameran (`facingMode: 'environment'`) och
 * `@zxing/browser`. Hooken startar strömmen mot `<video>`, anropar `onDecode` med varje avläst
 * text och stoppar kameran när skärmen lämnas. Debounce och pausning sker hos anroparen.
 */
import { BrowserQRCodeReader } from '@zxing/browser';
import { useEffect, useRef, useState, type RefObject } from 'react';

export type CameraState = 'starting' | 'ready' | 'denied' | 'unavailable';

const SCAN_ATTEMPT_DELAY_MS = 150;

function isPermissionDenied(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError')
  );
}

export function useQrScanner(onDecode: (text: string) => void): {
  videoRef: RefObject<HTMLVideoElement | null>;
  cameraState: CameraState;
} {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onDecodeRef = useRef(onDecode);
  onDecodeRef.current = onDecode;
  const [cameraState, setCameraState] = useState<CameraState>('starting');

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) {
      return undefined;
    }
    let isCancelled = false;
    let stop: (() => void) | undefined;
    const reader = new BrowserQRCodeReader(undefined, {
      delayBetweenScanAttempts: SCAN_ATTEMPT_DELAY_MS,
    });
    reader
      .decodeFromConstraints(
        { video: { facingMode: 'environment' }, audio: false },
        video,
        (result) => {
          // `result` saknas medan ingen QR-kod syns i bild; det är inte ett fel.
          if (result !== undefined) {
            onDecodeRef.current(result.getText());
          }
        },
      )
      .then((controls) => {
        if (isCancelled) {
          controls.stop();
          return;
        }
        stop = () => controls.stop();
        setCameraState('ready');
      })
      .catch((error: unknown) => {
        if (!isCancelled) {
          setCameraState(isPermissionDenied(error) ? 'denied' : 'unavailable');
        }
      });
    return () => {
      isCancelled = true;
      stop?.();
    };
  }, []);

  return { videoRef, cameraState };
}
