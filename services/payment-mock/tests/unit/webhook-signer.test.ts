import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signWebhookPayload } from '../../src/services/webhook-signer.js';

describe('signWebhookPayload', () => {
  it("produces a header in Stripe's t=/v1= format", () => {
    const header = signWebhookPayload('{"a":1}', 'secret');
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it('matches the HMAC-SHA256 Stripe itself would compute for the same timestamp and payload', () => {
    const payload = '{"hello":"world"}';
    const secret = 'whsec_test';
    const header = signWebhookPayload(payload, secret);
    const timestamp = header.match(/^t=(\d+),/)?.[1];
    expect(timestamp).toBeDefined();

    const expectedSignature = createHmac('sha256', secret)
      .update(`${timestamp}.${payload}`)
      .digest('hex');
    expect(header).toBe(`t=${timestamp},v1=${expectedSignature}`);
  });

  it('produces a different signature for a different secret', () => {
    const a = signWebhookPayload('payload', 'secret-a');
    const b = signWebhookPayload('payload', 'secret-b');
    expect(a).not.toBe(b);
  });
});
