/**
 * Result of a successful (network-level) outbound request. Returned for any
 * HTTP status code — non-2xx responses are not exceptions; the caller decides
 * how to react. Errors are only thrown for SSRF rejection, timeout, network
 * failure, or redirect-loop conditions.
 *
 * The generic `T` reflects the expected shape of `body` after decoding per
 * `responseType`. When `responseType === 'json'` and the payload cannot be
 * parsed as JSON, `body` is `null` and the caller can read `raw` to recover.
 */
export interface SafeHttpResponse<T = unknown> {
  /** HTTP status code from the final response (after redirects). */
  status: number;

  /**
   * Lower-cased header names mapped to their values. Multi-value headers
   * are joined with `, ` per RFC 7230 §3.2.2.
   */
  headers: Readonly<Record<string, string>>;

  /**
   * Decoded body per `responseType`. `null` when decoding failed (e.g. JSON
   * parse failure) or when the response had an empty body.
   */
  body: T | null;

  /**
   * Raw response payload. String for `responseType: 'json' | 'text'`,
   * `ArrayBuffer` for `responseType: 'arraybuffer'`. Always populated even
   * when `body` is `null`, so callers can inspect what was received.
   */
  raw: string | ArrayBuffer;

  /** Wall-clock duration from request start to final response, in milliseconds. */
  durationMs: number;

  /**
   * The URL of the final response. Differs from the original request URL
   * when redirects were followed.
   */
  finalUrl: string;

  /** Number of redirects followed (0 if the original URL responded directly). */
  redirectCount: number;
}
