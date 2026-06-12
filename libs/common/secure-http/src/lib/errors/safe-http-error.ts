/**
 * String-literal discriminator for `SafeHttpError` subclasses. Lets callers
 * branch on errors without `instanceof` chains and lets serializers project
 * errors into log/telemetry payloads with a stable identifier.
 */
export type SafeHttpErrorCode =
  | 'SSRF_REJECTION'
  | 'INVALID_REQUEST_URL'
  | 'REDIRECT_DENIED'
  | 'REDIRECT_LIMIT_EXCEEDED'
  | 'REQUEST_TIMEOUT'
  | 'OUTBOUND_NETWORK_ERROR';

/**
 * Base class for every error thrown by `SafeHttpService`. Concrete subclasses
 * carry per-failure context (rejected host, redirect target, etc.). HTTP-level
 * non-success statuses (4xx, 5xx) are NOT thrown — they're returned on
 * `SafeHttpResponse.status` so callers can branch on application semantics.
 */
export abstract class SafeHttpError extends Error {
  /** Discriminating tag for switch-based handling. */
  abstract readonly code: SafeHttpErrorCode;

  protected constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    // Preserve `instanceof` across the TS down-leveling boundary.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
