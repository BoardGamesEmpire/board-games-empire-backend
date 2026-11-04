import { createHash, timingSafeEqual } from 'node:crypto';

/** A SHA-256 hash in base64url without padding: 43 characters. */
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** RFC 7636 §4.1: 43 to 128 unreserved characters. */
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** Whether `value` has the shape of an S256 PKCE challenge (#1019). */
export function isS256Challenge(value: string): boolean {
  return S256_CHALLENGE.test(value);
}

/** Whether `value` has the shape of a PKCE code verifier (#1019). */
export function isCodeVerifier(value: string): boolean {
  return CODE_VERIFIER.test(value);
}

/**
 * Whether `verifier` is the one `challenge` was made from: its SHA-256 hash in
 * base64url without padding (RFC 7636 §4.6), compared in constant time
 * (#1019). Answers `false` for a malformed value instead of throwing.
 */
export function verifierMatchesChallenge(verifier: string, challenge: string): boolean {
  if (!isCodeVerifier(verifier) || !isS256Challenge(challenge)) {
    return false;
  }

  const expected = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const given = Buffer.from(challenge);

  return expected.length === given.length && timingSafeEqual(expected, given);
}
