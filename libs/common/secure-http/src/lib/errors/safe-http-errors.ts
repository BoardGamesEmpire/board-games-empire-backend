import type { SsrfRejectionReason } from '../interfaces/outbound-http-observer.interface';
import { SafeHttpError } from './safe-http-error';

/**
 * The destination failed the SSRF gauntlet — either during initial validation
 * or on a redirect hop (in which case `RedirectToDisallowedTargetError` wraps
 * this and is thrown instead).
 */
export class SsrfRejectionError extends SafeHttpError {
  readonly code = 'SSRF_REJECTION' as const;

  constructor(
    readonly host: string,
    readonly reason: SsrfRejectionReason,
    /** Resolved IP when DNS succeeded but the address failed validation. */
    readonly ip?: string,
  ) {
    super(`SSRF rejection (${reason}): ${host}${ip ? ` (resolved to ${ip})` : ''}`);
  }
}

/**
 * The supplied URL could not be parsed or used a non-`http(s)` scheme. This
 * is structural — no DNS or network activity occurred.
 */
export class InvalidRequestUrlError extends SafeHttpError {
  readonly code = 'INVALID_REQUEST_URL' as const;

  constructor(
    readonly url: string,
    readonly reason: 'parse-failure' | 'invalid-scheme',
    detail?: string,
  ) {
    super(`Invalid request URL (${reason}): ${url}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * A `Location` header on a 3xx response pointed at a destination that failed
 * the SSRF gauntlet. The inner `cause` carries the underlying rejection.
 *
 * Common attack pattern: attacker registers `https://benign.example.com`
 * which responds with `Location: http://169.254.169.254/`. Initial URL
 * passes the gauntlet; the redirect hop is where the rejection bites.
 */
export class RedirectToDisallowedTargetError extends SafeHttpError {
  readonly code = 'REDIRECT_DENIED' as const;

  constructor(
    readonly from: string,
    readonly to: string,
    override readonly cause: SsrfRejectionError,
  ) {
    super(`Redirect from ${from} to disallowed target ${to}: ${cause.message}`);
  }
}

/**
 * Followed too many redirects. Configured per-request via
 * `SafeHttpRequestOptions.maxRedirects`, falling back to the admin policy
 * default. Independent of SSRF — this catches redirect loops.
 */
export class RedirectLimitExceededError extends SafeHttpError {
  readonly code = 'REDIRECT_LIMIT_EXCEEDED' as const;

  constructor(
    readonly url: string,
    readonly limit: number,
  ) {
    super(`Exceeded ${limit} redirect(s) starting from ${url}`);
  }
}

/**
 * The configured timeout elapsed before the response completed. Per-attempt;
 * retry policies re-arm the timeout on each attempt.
 */
export class RequestTimeoutError extends SafeHttpError {
  readonly code = 'REQUEST_TIMEOUT' as const;

  constructor(
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
  }
}

/**
 * Underlying network-level failure: connection refused, socket reset, TLS
 * handshake failure, DNS resolution failure, etc. The original error is
 * preserved on `cause` for diagnostics.
 *
 * Note: DNS failures encountered during the SSRF gauntlet surface as
 * `SsrfRejectionError` with reason `dns-failure`, not this — by the time
 * this error fires, the host had already passed validation and the failure
 * is in the actual request.
 */
export class OutboundNetworkError extends SafeHttpError {
  readonly code = 'OUTBOUND_NETWORK_ERROR' as const;

  constructor(
    readonly url: string,
    override readonly cause: Error,
  ) {
    super(`Network error reaching ${url}: ${cause.message}`);
  }
}
