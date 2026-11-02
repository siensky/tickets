/**
 * (docs/rules.md §1 säger att services inte gör HTTP; detta är ett medvetet undantag, samma som stripe-client.ts:
 * siteverify är ett externt API och logiken runt det — validering av success/action/hostname — hör ihop med anropet.)
 *
 * Cloudflare Turnstile för botskyddets nivå 2 (docs/plan.md 8.5). Servern verifierar token mot `siteverify` med
 * 2 s timeout och validerar svaret (`success`, `action`, `hostname`). Fail-closed: ett nätverksfel eller en
 * timeout räknas som misslyckad verifiering, men anropas bara när nivå 2 redan är beslutad.
 */
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 2000;
export const TURNSTILE_ACTION = 'queue_join';

export interface TurnstileConfig {
  readonly secret: string;
  /** Hostnamnet widgeten renderades på (t.ex. `tikknet.se`); `undefined` hoppar över hostname-kontrollen. */
  readonly expectedHostname: string | undefined;
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

function readField(data: unknown, field: string): unknown {
  return typeof data === 'object' && data !== null ? Reflect.get(data, field) : undefined;
}

function rejectionReason(config: TurnstileConfig, data: unknown): string | undefined {
  if (readField(data, 'success') !== true) {
    return 'token rejected';
  }
  if (readField(data, 'action') !== TURNSTILE_ACTION) {
    return 'unexpected action';
  }
  if (
    config.expectedHostname !== undefined &&
    readField(data, 'hostname') !== config.expectedHostname
  ) {
    return 'unexpected hostname';
  }
  return undefined;
}

export async function verifyTurnstileToken(
  config: TurnstileConfig,
  token: string,
  ip: string,
  fetchFn: FetchFn = fetch,
  onFailure: (reason: string) => void = () => undefined,
): Promise<boolean> {
  try {
    const body = new URLSearchParams({ secret: config.secret, response: token, remoteip: ip });
    const response = await fetchFn(SITEVERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      onFailure(`siteverify answered ${response.status}`);
      return false;
    }
    const data: unknown = await response.json();
    const reason = rejectionReason(config, data);
    if (reason !== undefined) {
      onFailure(reason);
    }
    return reason === undefined;
  } catch (error) {
    onFailure(error instanceof Error ? error.name : 'siteverify failed');
    return false;
  }
}
