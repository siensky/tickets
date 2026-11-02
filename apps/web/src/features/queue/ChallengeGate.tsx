/**
 * Visar Cloudflare Turnstile när `queue/join` kräver nivå 2 i botskyddet (docs/plan.md 8.5). Proof of work (nivå 1)
 * löses utan UI i lib/challenge.ts; den här komponenten renderas bara medan en Turnstile-utmaning väntar och
 * annars ingenting. Skriptet laddas först när det behövs (ingen npm-beroende, ingen laddning för vanliga besökare).
 */
import { useCallback, useEffect, useRef, useState, type JSX, type RefObject } from 'react';
import { Alert } from '../../components/ui/Alert.js';
import { registerTurnstileListener } from '../../lib/challenge.js';

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY;

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      callback: (token: string) => void;
      'error-callback': () => void;
    },
  ): string;
  remove(widgetId: string): void;
}

declare global {
  // Cloudflares skript lägger själv `turnstile` på window (formen enligt deras dokumentation).
  interface Window {
    turnstile?: TurnstileApi;
  }
}

function turnstileApi(): TurnstileApi | undefined {
  return window.turnstile;
}

function loadScript(): Promise<TurnstileApi> {
  return new Promise((resolve, reject) => {
    const existing = turnstileApi();
    if (existing !== undefined) {
      resolve(existing);
      return;
    }
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = (): void => {
      const api = turnstileApi();
      return api === undefined ? reject(new Error('turnstile missing')) : resolve(api);
    };
    script.onerror = (): void => reject(new Error('turnstile script failed to load'));
    document.head.appendChild(script);
  });
}

interface Pending {
  readonly resolve: (token: string) => void;
  readonly reject: (error: Error) => void;
}

/** Renderar Turnstile-widgeten i `container` medan en utmaning väntar och lämnar tillbaka token eller fel. */
function useTurnstileWidget(
  pending: Pending | undefined,
  container: RefObject<HTMLDivElement | null>,
  done: () => void,
): void {
  useEffect(() => {
    if (pending === undefined || container.current === null) {
      return undefined;
    }
    if (SITE_KEY === undefined || SITE_KEY === '') {
      pending.reject(new Error('VITE_TURNSTILE_SITE_KEY is not set'));
      return undefined;
    }
    const element = container.current;
    let widgetId: string | undefined;
    let api: TurnstileApi | undefined;
    loadScript()
      .then((loaded) => {
        api = loaded;
        widgetId = loaded.render(element, {
          sitekey: SITE_KEY,
          action: 'queue_join',
          callback: (token) => {
            pending.resolve(token);
            done();
          },
          'error-callback': () => pending.reject(new Error('turnstile failed')),
        });
      })
      .catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error('turnstile failed'));
      });
    return () => {
      if (widgetId !== undefined) {
        api?.remove(widgetId);
      }
    };
  }, [pending, container, done]);
}

export function ChallengeGate(): JSX.Element | null {
  const [pending, setPending] = useState<Pending | undefined>();
  const container = useRef<HTMLDivElement>(null);
  const clear = useCallback(() => setPending(undefined), []);

  useEffect(() => {
    registerTurnstileListener((resolve, reject) => setPending({ resolve, reject }));
    return () => registerTurnstileListener(undefined);
  }, []);
  useTurnstileWidget(pending, container, clear);

  if (pending === undefined) {
    return null;
  }
  return (
    <div className="flex flex-col items-center gap-3">
      <Alert tone="info">
        Det är många som köar just nu. Bekräfta att du är en människa för att gå vidare.
      </Alert>
      <div ref={container} />
    </div>
  );
}
