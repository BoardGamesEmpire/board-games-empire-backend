import type { SafeHttpRetryPolicy } from './safe-http-retry-policy.interface';

/**
 * HTTP methods accepted by `SafeHttpService.request`. The service is verb-agnostic
 * for SSRF purposes — the gauntlet runs identically for `GET` and `POST` — but
 * limiting the union to standard methods prevents typos from masquerading as
 * intentional choices (`GETT`, `delete`, etc.).
 */
export type SafeHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/**
 * How the response body should be decoded. The service always retains the
 * raw bytes (or string) on `SafeHttpResponse.raw`; this only controls how
 * `body` is materialized.
 *
 * - `json`    — parse as UTF-8 JSON. On parse failure, `body` is `null` and
 *               the caller can inspect `raw`. The service does NOT throw.
 * - `text`    — decode as UTF-8 string.
 * - `arraybuffer` — keep as `ArrayBuffer`.
 */
export type SafeHttpResponseType = 'json' | 'text' | 'arraybuffer';

/**
 * Bodies accepted by `SafeHttpService.request`. Plain objects and arrays are
 * JSON-stringified; strings and binary types pass through unmodified.
 *
 * When sending JSON, the service sets `Content-Type: application/json` unless
 * the caller already supplied one.
 */
export type SafeHttpRequestBody = string | Uint8Array | ArrayBuffer | Record<string, unknown> | unknown[];

/**
 * Per-request options. All fields are optional; defaults come from the
 * admin-controlled `SafeHttpPolicy` snapshot (timeout, redirects) or are
 * inert (no retry, no body, no abort signal).
 *
 * Notably absent (by design):
 *   - `trust` — every call goes through the same gauntlet
 *   - `allowedDomains` — caller can pre-check the URL before calling
 *   - `strict` — strict mode is global, not per-call
 */
export interface SafeHttpRequestOptions {
  /** Default `GET`. */
  method?: SafeHttpMethod;

  /**
   * Headers forwarded verbatim. `Host` is set automatically by the service
   * to the URL's original hostname (for vhost routing on a pinned IP); any
   * `Host` entry the caller supplies is overwritten.
   */
  headers?: Record<string, string>;

  /** Request body. Object/array bodies are JSON-stringified. */
  body?: SafeHttpRequestBody;

  /** Per-request timeout in milliseconds. Overrides the policy default. */
  timeoutMs?: number;

  /**
   * Per-request redirect cap. Overrides the policy default. A non-negative
   * integer; anything else is a `RangeError` before any request.
   */
  maxRedirects?: number;

  /** Default `json`. */
  responseType?: SafeHttpResponseType;

  /**
   * Optional retry policy. The service applies retry around the entire
   * request including the SSRF gauntlet — every attempt re-resolves DNS
   * and re-validates the target, so retry cannot be used to evade SSRF
   * after the policy snapshot changes mid-flight.
   */
  retry?: SafeHttpRetryPolicy;

  /**
   * Caller-controlled cancellation. Composes with the request timeout —
   * whichever fires first wins.
   */
  signal?: AbortSignal;
}

/**
 * Options for `SafeHttpService.download`. The body is streamed to
 * `destination` instead of being held in memory, so the byte cap is the
 * caller's, not the 10 MiB ceiling of `request()`. There is no retry.
 */
export interface SafeHttpDownloadOptions {
  /**
   * File to write. It is created exclusively (`wx`): an existing path is an
   * error, and is left untouched. On any failure after creation it is removed.
   */
  destination: string;

  /**
   * Most bytes the body may hold. Past it the download fails and no file
   * stays. A value that is not a non-negative integer is refused.
   */
  maxBytes: number;

  /**
   * One time limit for the whole transfer, counted from the call. It cuts off
   * every hop's connection, its answer and the body as they arrive. The
   * outbound HTTP policy's address lookup before each hop is not cut off by
   * it, though the time it takes counts: the resolver's own timeouts bound the
   * lookup.
   */
  timeoutMs: number;

  headers?: Record<string, string>;

  /**
   * Per-download redirect cap. Overrides the policy default. A non-negative
   * integer; anything else is a `RangeError` before any request.
   */
  maxRedirects?: number;

  /** Caller-controlled cancellation. Composes with the time limit. */
  signal?: AbortSignal;
}
