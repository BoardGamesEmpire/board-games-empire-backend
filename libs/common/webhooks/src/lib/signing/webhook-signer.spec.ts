import { createHmac } from 'node:crypto';
import { WebhookSigner } from './webhook-signer';

describe('WebhookSigner', () => {
  let signer: WebhookSigner;
  const secret = 'whsec_test_0123456789abcdef';
  const body = JSON.stringify({ id: 'evt_1', type: 'event.event.created.v1', data: { eventId: 'e1' } });

  beforeEach(() => {
    signer = new WebhookSigner();
  });

  it('signs HMAC-SHA256 over `${timestamp}.${body}` (GitHub/Stripe shape)', () => {
    const timestamp = 1_700_000_000;
    const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

    expect(signer.sign(secret, body, timestamp)).toEqual({ timestamp, signature: expected });
  });

  it('is deterministic for a fixed timestamp', () => {
    const a = signer.sign(secret, body, 1_700_000_000);
    const b = signer.sign(secret, body, 1_700_000_000);
    expect(a.signature).toBe(b.signature);
  });

  it('binds the signature to the timestamp (replay defense)', () => {
    const a = signer.sign(secret, body, 1_700_000_000);
    const b = signer.sign(secret, body, 1_700_000_001);
    expect(a.signature).not.toBe(b.signature);
  });

  it('defaults the timestamp to now when omitted', () => {
    const before = Math.floor(Date.now() / 1000);
    const { timestamp } = signer.sign(secret, body);
    const after = Math.floor(Date.now() / 1000);

    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  describe('verify', () => {
    it('accepts a signature it produced', () => {
      const { timestamp, signature } = signer.sign(secret, body, 1_700_000_000);
      expect(signer.verify(secret, body, timestamp, signature)).toBe(true);
    });

    it('rejects a tampered body', () => {
      const { timestamp, signature } = signer.sign(secret, body, 1_700_000_000);
      expect(signer.verify(secret, `${body} `, timestamp, signature)).toBe(false);
    });

    it('rejects a wrong secret', () => {
      const { timestamp, signature } = signer.sign(secret, body, 1_700_000_000);
      expect(signer.verify('whsec_other_secret_value', body, timestamp, signature)).toBe(false);
    });

    it('rejects a wrong-length signature without throwing', () => {
      const { timestamp } = signer.sign(secret, body, 1_700_000_000);
      expect(signer.verify(secret, body, timestamp, 'short')).toBe(false);
    });
  });
});
