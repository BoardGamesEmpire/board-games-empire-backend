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
  /**
   * Decoded body per `responseType`. `null` when decoding failed (e.g. JSON
   * parse failure) or when the response had an empty body.
   */
  body: T | null;

  /** Wall-clock duration from request start to final response, in milliseconds. */
  durationMs: number;

  /**
   * The URL of the final response. Differs from the original request URL
   * when redirects were followed.
   */
  finalUrl: string;

  /**
   * Lower-cased header names mapped to their values. Multi-value headers
   * are joined with `, ` per RFC 7230 §3.2.2. That includes `set-cookie`,
   * whose joined value can't be split again: read `setCookie` for cookies.
   */
  headers: Readonly<Record<string, string>>;

  /**
   * Raw response payload. String for `responseType: 'json' | 'text'`,
   * `ArrayBuffer` for `responseType: 'arraybuffer'`. Always populated even
   * when `body` is `null`, so callers can inspect what was received.
   */
  raw: string | ArrayBuffer;

  /** Number of redirects followed (0 if the original URL responded directly). */
  redirectCount: number;

  /**
   * Each `Set-Cookie` header of the final response by itself, in the order
   * it arrived. Empty when there was none (#1083).
   */
  setCookie: readonly string[];

  /** HTTP status code from the final response (after redirects). */
  status: number;

  /**
   * The reason phrase of the final response's status line as the server sent
   * it, `Service Unavailable` for example. Empty when there was none, as over
   * HTTP/2. The plugin HTTP client's Response carries it, as fetch's does (#1083).
   */
  statusText: string;
}

/**
 * Result of `SafeHttpService.download`. Like `SafeHttpResponse`, any HTTP
 * status is a result, not an error. Only a 2xx answer is written; any other
 * status has `written: null` and leaves no file.
 */
export interface SafeHttpDownloadResult {
  durationMs: number;
  finalUrl: string;
  headers: Readonly<Record<string, string>>;
  redirectCount: number;
  status: number;

  /** What reached the file (2xx only): its length and lowercase hex SHA-256. */
  written: { bytes: number; sha256: string } | null;
}
