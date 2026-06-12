import type { IpFamily } from '../ip';

/**
 * A resolved DNS record. Matches Node's `dns.LookupAddress` shape so the
 * default implementation can pass through with no transformation.
 */
export interface ResolvedAddress {
  address: string;

  /**
   * 4 for IPv4 (A record), 6 for IPv6 (AAAA record).
   */
  family: IpFamily;
}

/**
 * Hostname-to-IP resolution layer. The default implementation wraps
 * `dns.promises.lookup` (which goes through `getaddrinfo` and honors
 * `/etc/hosts`, NSS, and the system resolver) — that matters because the
 * actual connect path uses the same resolution machinery. Anything else
 * would create a TOCTOU window between policy check and connect.
 *
 * Injected via {@link DNS_RESOLVER}. Tests bind a deterministic fake
 * implementation; production binds {@link DefaultDnsResolver}.
 *
 * Implementations MUST:
 *  - Return all resolved addresses (both A and AAAA records), not just the
 *    first. Multi-record evasion checks depend on seeing every candidate.
 *  - Throw {@link DnsResolutionError} on lookup failure. Empty-array return
 *    is not a valid response.
 *  - Short-circuit IP-literal hostnames (`10.0.0.1`, `[::1]`) by returning
 *    them as their own resolution without a DNS query.
 */
export interface DnsResolver {
  resolveAll(hostname: string): Promise<ResolvedAddress[]>;
}

/**
 * Thrown by {@link DnsResolver.resolveAll} on any resolution failure
 * (NXDOMAIN, timeout, network error, etc.). Caught by `IpPolicyService`
 * and surfaced as `SsrfRejectionError` with reason `dns-failure` — DNS
 * failure is treated as rejection rather than network error because the
 * destination cannot be safely classified.
 */
export class DnsResolutionError extends Error {
  constructor(
    readonly hostname: string,
    override readonly cause: Error,
  ) {
    super(`DNS lookup failed for ${hostname}: ${cause.message}`);
    this.name = 'DnsResolutionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
