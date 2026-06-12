import type { SsrfRejectionReason } from '../interfaces/outbound-http-observer.interface';
import type { IpFamily } from './ip';

/**
 * Result of `IpPolicyService.evaluate`. Discriminated by `allowed` — the
 * caller (`SafeHttpService`) branches on this to either pin the connection
 * to `pinnedIp` or throw an `SsrfRejectionError` carrying the reason.
 */
export type IpPolicyDecision = IpPolicyAllow | IpPolicyReject;

export interface IpPolicyAllow {
  allowed: true;

  /**
   * The IP address the connection MUST be made to (closes the rebind window).
   */
  pinnedIp: string;

  /**
   * Family of `pinnedIp`. Lets the caller configure the right Agent at connect time.
   */
  pinnedFamily: IpFamily;

  /**
   * The hostname originally resolved, for the `Host` header on the pinned request.
   */
  hostname: string;
}

export interface IpPolicyReject {
  allowed: false;
  reason: SsrfRejectionReason;

  /**
   * The hostname under evaluation. Always present.
   */
  hostname: string;

  /**
   * The resolved IP that triggered the rejection. Absent when rejection is at the hostname/scheme layer.
   */
  ip?: string;

  /**
   * Human-readable rule label for logs/audit. Examples:
   *   - `permanent-hostname:metadata.google.internal`
   *   - `admin-blocklist:cidr:10.0.0.0/8`
   *   - `default-private:cidr:127.0.0.0/8`
   *   - `ipv4-mapped-evasion`
   */
  rule: string;
}
