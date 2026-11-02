import { describe, expect, it, vi } from 'vitest';
import { TURNSTILE_ACTION, verifyTurnstileToken } from '../../src/services/turnstile.js';

const CONFIG = { secret: 'secret', expectedHostname: 'tikknet.se' };

function respond(body: unknown, status = 200): () => Promise<Response> {
  return () => Promise.resolve(Response.json(body, { status }));
}

describe('verifyTurnstileToken', () => {
  it('godkänner success + rätt action + rätt hostname', async () => {
    const ok = respond({ success: true, action: TURNSTILE_ACTION, hostname: 'tikknet.se' });
    expect(await verifyTurnstileToken(CONFIG, 't', '1.2.3.4', ok)).toBe(true);
  });

  it.each([
    ['success=false', { success: false, action: TURNSTILE_ACTION, hostname: 'tikknet.se' }],
    ['fel action', { success: true, action: 'login', hostname: 'tikknet.se' }],
    ['fel hostname', { success: true, action: TURNSTILE_ACTION, hostname: 'evil.example' }],
    ['ingen body', {}],
  ])('nekar vid %s och loggar orsaken', async (_name, body) => {
    const onFailure = vi.fn();

    expect(await verifyTurnstileToken(CONFIG, 't', '1.2.3.4', respond(body), onFailure)).toBe(
      false,
    );
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('nekar (fail-closed) vid HTTP-fel och nätverksfel, utan att läcka token eller secret', async () => {
    const onFailure = vi.fn();
    expect(
      await verifyTurnstileToken(CONFIG, 't', '1.2.3.4', respond({}, 500), onFailure),
    ).toBe(false);
    expect(
      await verifyTurnstileToken(
        CONFIG,
        't',
        '1.2.3.4',
        () => Promise.reject(new Error('timeout')),
        onFailure,
      ),
    ).toBe(false);
    expect(JSON.stringify(onFailure.mock.calls)).not.toContain('secret');
  });
});
