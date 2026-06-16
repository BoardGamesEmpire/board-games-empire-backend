import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WebhookSignatureParts {
  /** Unix epoch seconds at signing time. Sent as `X-BGE-Timestamp`. */
  readonly timestamp: number;
  /** Hex HMAC-SHA256 over `${timestamp}.${body}`. Sent as `X-BGE-Signature`. */
  readonly signature: string;
}

/**
 * Computes the outbound signature receivers verify. Signs `timestamp + "." +
 * body` (the timestamp binds the signature to a moment, defeating replay) with
 * HMAC-SHA256 and the per-subscription secret — the GitHub/Stripe shape, so
 * receivers can reuse familiar verification code.
 *
 * `verify` is included for symmetry and for the (deferred) inbound
 * test-endpoint; it uses a constant-time compare.
 */
@Injectable()
export class WebhookSigner {
  sign(secret: string, body: string, timestamp: number = Math.floor(Date.now() / 1000)): WebhookSignatureParts {
    const signature = this.computeSignature(secret, timestamp, body);
    return { timestamp, signature };
  }

  /**
   * Constant-time verification of a presented signature.
   *
   * NOTE: this verifies the HMAC only — it does NOT enforce a freshness window
   * on `timestamp`, so a captured signature verifies forever. The signing
   * timestamp exists to make that window enforceable by the caller; it is not
   * self-enforcing here.
   *
   * @todo(#56-replay): when an inbound verification path goes live (e.g. the
   *   deferred subscription test/validation endpoint), reject timestamps outside
   *   a tolerance (~5 min) before/alongside this check. Until then `verify` is
   *   off any live path.
   */
  verify(secret: string, body: string, timestamp: number, presented: string): boolean {
    const expected = this.computeSignature(secret, timestamp, body);
    const expectedBuffer = Buffer.from(expected, 'utf-8');
    const presentedBuffer = Buffer.from(presented, 'utf-8');

    // timingSafeEqual throws on length mismatch; guard first so a wrong-length
    // signature is a clean `false`, not an exception.
    if (expectedBuffer.length !== presentedBuffer.length) {
      return false;
    }
    return timingSafeEqual(expectedBuffer, presentedBuffer);
  }

  private computeSignature(secret: string, timestamp: number, body: string): string {
    return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  }
}
