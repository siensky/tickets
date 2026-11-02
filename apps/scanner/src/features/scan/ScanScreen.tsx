/**
 * Kameravyn (docs/plan.md 7.8): video, kamerafel och resultatet i helskärm. Själva
 * skickandet och debouncen ligger i `use-scan-submission.ts`.
 */
import type { JSX, RefObject } from 'react';
import type { ScanEvent } from '../../lib/api-client.js';
import { CameraProblem } from './CameraProblem.js';
import { ScanResultOverlay } from './ScanResultOverlay.js';
import { useScanSubmission } from './use-scan-submission.js';
import { useQrScanner, type CameraState } from './use-qr-scanner.js';

function CameraView({
  videoRef,
  cameraState,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  cameraState: CameraState;
}): JSX.Element {
  if (cameraState === 'denied' || cameraState === 'unavailable') {
    return <CameraProblem kind={cameraState} />;
  }
  return (
    <div className="relative overflow-hidden rounded-box bg-neutral">
      <video ref={videoRef} className="aspect-square w-full object-cover" muted playsInline />
      {cameraState === 'starting' ? (
        <p
          role="status"
          className="absolute inset-0 grid place-items-center text-neutral-content"
        >
          Startar kameran…
        </p>
      ) : null}
    </div>
  );
}

export function ScanScreen({
  event,
  gate,
  getAccessToken,
  onChangeSetup,
}: {
  event: ScanEvent;
  gate: string;
  getAccessToken: () => Promise<string>;
  onChangeSetup: () => void;
}): JSX.Element {
  const { display, handleDecode } = useScanSubmission(event, gate, getAccessToken);
  const { videoRef, cameraState } = useQrScanner((text) => void handleDecode(text));

  return (
    <div className="flex min-h-dvh flex-col gap-4 p-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1>{event.title}</h1>
          <p className="text-muted">{gate}</p>
        </div>
        <button
          type="button"
          className="btn btn-outline btn-neutral min-h-11"
          onClick={onChangeSetup}
        >
          Byt event eller grind
        </button>
      </header>
      <CameraView videoRef={videoRef} cameraState={cameraState} />
      <p className="text-center text-muted">Rikta kameran mot biljettens QR-kod.</p>
      {display === undefined ? null : (
        <ScanResultOverlay display={display} eventTitle={event.title} />
      )}
    </div>
  );
}
