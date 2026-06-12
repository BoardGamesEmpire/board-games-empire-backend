import type { SafeHttpError } from '../errors/safe-http-error';
import type { SafeHttpMethod } from './safe-http-request.interface';

/**
 * Why a destination was rejected by the SSRF gauntlet. The discriminator
 * lets observers (metrics, OTel processors, audit log writers) categorize
 * rejections without parsing error messages.
 *
 * - `permanent-blocklist` — hardcoded denylist hit (cloud metadata IP/host,
 *   unspecified address). Not admin-overridable.
 * - `admin-blocklist`     — `SafeHttpPolicy.blockedHosts` or `blockedCidrs`
 *   hit. Admin intended this; treat as routine.
 * - `private-range`       — resolved IP fell in a default-private range
 *   (RFC1918, loopback, link-local, ULA, multicast) and was not on an
 *   admin allowlist. Common for SaaS deployments processing user-supplied
 *   webhook URLs.
 * - `invalid-scheme`      — URL scheme other than `http` or `https`.
 * - `invalid-url`         — URL could not be parsed.
 * - `dns-failure`         — DNS lookup failed (NXDOMAIN, timeout, etc.).
 * - `ipv4-mapped-evasion` — IPv6 literal `::ffff:x.x.x.x` resolved to a
 *   private IPv4. Flagged separately to highlight attempted evasion.
 */
export type SsrfRejectionReason =
  | 'permanent-blocklist'
  | 'admin-blocklist'
  | 'private-range'
  | 'invalid-scheme'
  | 'invalid-url'
  | 'dns-failure'
  | 'ipv4-mapped-evasion';

export interface OutboundRequestEvent {
  url: string;
  method: SafeHttpMethod;
  attempt: number;
}

export interface OutboundResponseEvent {
  url: string;
  method: SafeHttpMethod;
  status: number;
  durationMs: number;
  redirectCount: number;
}

export interface OutboundErrorEvent {
  url: string;
  method: SafeHttpMethod;
  error: SafeHttpError;
  durationMs: number;
}

export interface SsrfRejectionEvent {
  host: string;
  /** Resolved IP, when DNS succeeded but the IP fell into a deny rule. */
  ip?: string;
  reason: SsrfRejectionReason;
}

export interface RedirectDeniedEvent {
  /** The URL that returned the redirect. */
  from: string;
  /** The `Location` target that failed the gauntlet. */
  to: string;
  reason: SsrfRejectionReason;
}

/**
 * Optional hook surface for telemetry, audit logging, and per-call accounting.
 * All methods are optional — the default `NoopOutboundHttpObserver` implements
 * none. Custom observers implement only the events they care about.
 *
 * Implementations should not throw — the service treats observer errors as
 * non-fatal and logs them at warn level. This isolates the request path
 * from buggy or slow observers.
 *
 * Wiring: a single observer is bound via `OUTBOUND_HTTP_OBSERVER`. To fan
 * out to multiple consumers (metrics + audit log + OTel), implement a
 * composite observer that delegates to a list. Keeping the DI surface
 * single-implementor avoids ordering and short-circuit ambiguities.
 */
export interface OutboundHttpObserver {
  onRequest?(event: OutboundRequestEvent): void | Promise<void>;
  onResponse?(event: OutboundResponseEvent): void | Promise<void>;
  onError?(event: OutboundErrorEvent): void | Promise<void>;
  onSsrfRejection?(event: SsrfRejectionEvent): void | Promise<void>;
  onRedirectDenied?(event: RedirectDeniedEvent): void | Promise<void>;
}
