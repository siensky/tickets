/**
 * Scannerns flöde (docs/plan.md 7.8): logga in → behörighet `scan:tickets` → välj event →
 * välj grind → kameravy. "Byt event eller grind" tar tillbaka till valen.
 */
import { useState, type JSX } from 'react';
import type { Gate } from './config.js';
import { ScanScreen } from './features/scan/ScanScreen.js';
import { AccessGate } from './features/session/AccessGate.js';
import { SetupScreen } from './features/setup/SetupScreen.js';
import type { ScanEvent } from './lib/api-client.js';

interface Selection {
  readonly event: ScanEvent;
  readonly gate: Gate;
}

export function App(): JSX.Element {
  const [selection, setSelection] = useState<Selection | undefined>();
  return (
    <AccessGate>
      {(getAccessToken, logoutButton) =>
        selection === undefined ? (
          <SetupScreen
            logoutButton={logoutButton}
            onStart={(event, gate) => setSelection({ event, gate })}
          />
        ) : (
          <ScanScreen
            event={selection.event}
            gate={selection.gate}
            getAccessToken={getAccessToken}
            onChangeSetup={() => setSelection(undefined)}
          />
        )
      }
    </AccessGate>
  );
}
