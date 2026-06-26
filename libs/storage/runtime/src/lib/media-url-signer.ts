import { SignatureExpiredError, SignatureInvalidError, type StorageOp } from '@boardgamesempire/storage-contract';
import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SigningKeyService } from './signing-key.service.js';

/** Everything bound into a signed URL's HMAC. Values are recovered server-side at verify time. */
export interface SignaturePayload {
  readonly key: string;
  readonly op: StorageOp;
  /** Expiry as epoch seconds. */
  readonly expiresAt: number;
  readonly contentType?: string;
  readonly bindings?: Readonly<Record<string, string>>;
}

/**
 * Computes and verifies HMAC-SHA256 signatures over signed-URL payloads. Used by
 * `LocalDiskDriver` to mint URLs and by the streaming controller to verify them,
 * so the algorithm lives in one place. Binding `contentType` and domain claims
 * (e.g. `ownerId`) into the payload defeats confused-deputy replay: a captured
 * signature can't be reused against a different object, content type, or owner.
 */
@Injectable()
export class MediaUrlSigner {
  constructor(private readonly keys: SigningKeyService) {}

  async sign(payload: SignaturePayload): Promise<string> {
    const secret = await this.keys.getSecret();
    return createHmac('sha256', secret).update(this.canonicalize(payload)).digest('hex');
  }

  /**
   * Verifies a signature against its payload. Throws `SignatureInvalidError` on
   * mismatch (checked first, in constant time) and `SignatureExpiredError` when a
   * validly-signed URL has passed its expiry.
   */
  async verify(payload: SignaturePayload, signature: string): Promise<void> {
    const expected = await this.sign(payload);

    if (!this.constantTimeEquals(expected, signature)) {
      throw new SignatureInvalidError();
    }

    if (payload.expiresAt * 1000 < Date.now()) {
      throw new SignatureExpiredError();
    }
  }

  private canonicalize(payload: SignaturePayload): string {
    // Codepoint sort (not locale-dependent) for determinism across environments.
    const bindings = Object.entries(payload.bindings ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    // Structured JSON encoding: each field is independently quoted/escaped, so no
    // value (key, contentType, binding) can smuggle a delimiter and collide with a
    // different payload (which would enable signature replay across payloads).
    return JSON.stringify([payload.op, payload.key, payload.expiresAt, payload.contentType ?? null, bindings]);
  }

  private constantTimeEquals(expected: string, actual: string): boolean {
    // `actual` is attacker-controlled (URL query param). Reject anything that
    // isn't the exact hex shape of an HMAC-SHA256 digest before allocating a
    // Buffer from it, so an oversized/garbage value can't waste memory.
    if (actual.length !== expected.length || !/^[0-9a-f]+$/.test(actual)) {
      return false;
    }
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
  }
}
