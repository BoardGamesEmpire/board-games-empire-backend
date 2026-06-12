import { Inject, Injectable, Logger } from '@nestjs/common';
import { DEFAULT_PRIVATE_CIDRS, PERMANENT_BLOCKED_CIDRS, PERMANENT_BLOCKED_HOSTNAMES } from '../constants';
import { DnsResolutionError, type DnsResolver, type ResolvedAddress } from '../dns/dns-resolver.interface';
import type { SafeHttpPolicySnapshot } from '../interfaces/safe-http-policy-snapshot.interface';
import { DNS_RESOLVER } from '../safe-http.tokens';
import { findContainingCidr, parseCidrList, type ParsedCidr } from './cidr';
import { hostnameMatchesAny } from './hostname-matcher';
import { parseIp, type ParsedIp } from './ip';
import type { IpPolicyDecision, IpPolicyReject } from './ip-policy.types';

const PERMANENT_BLOCKED_PARSED: readonly ParsedCidr[] = parseCidrList(PERMANENT_BLOCKED_CIDRS);
const DEFAULT_PRIVATE_PARSED: readonly ParsedCidr[] = parseCidrList(DEFAULT_PRIVATE_CIDRS);

/**
 * The SSRF gauntlet. Given a target URL and the current policy snapshot,
 * decides whether the request may proceed and (if so) pins the IP the
 * connection MUST be made to.
 *
 * Evaluation order — defined by the locked design:
 *   1. Scheme check       — only `http`/`https` permitted.
 *   2. Hostname permanent blocklist — admin cannot override.
 *   3. Hostname admin blocklist     — admin chose to deny this host.
 *   4. DNS resolution      — gather all A and AAAA records.
 *   5. Per-IP, in order:
 *      a. Permanent CIDR blocklist (incl. IPv4-mapped IPv6 evasion).
 *      b. Admin CIDR blocklist.
 *      c. Admin hostname or CIDR allowlist → bypass (5d).
 *      d. Default private-range deny.
 *   6. Multi-record reject — if ANY resolved IP is rejected, reject the
 *      whole hostname. Closes the dual-record DNS evasion vector.
 *   7. Pin the first allowed IP for the connection.
 *
 * Returned `pinnedIp` is the value `SafeHttpService` passes to undici's
 * `Agent.connect` override. The hostname is preserved for the `Host` header
 * (vhost routing on the pinned IP).
 */
@Injectable()
export class IpPolicyService {
  private readonly logger = new Logger(IpPolicyService.name);

  constructor(@Inject(DNS_RESOLVER) private readonly dns: DnsResolver) {}

  async evaluate(url: URL, snapshot: SafeHttpPolicySnapshot): Promise<IpPolicyDecision> {
    // ── 1. Scheme ────────────────────────────────────────────────
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      this.logger.warn(`Rejecting URL(${url.href}) with disallowed scheme: ${url.protocol}`);

      return this.reject({
        hostname: url.hostname,
        reason: 'invalid-scheme',
        rule: `scheme:${url.protocol}`,
      });
    }

    const hostname = url.hostname.toLowerCase();

    // ── 2. Hostname permanent blocklist ──────────────────────────
    if (PERMANENT_BLOCKED_HOSTNAMES.has(hostname)) {
      this.logger.warn(`Rejecting URL(${url.href}) with permanently blocked hostname: ${hostname}`);

      return this.reject({
        hostname,
        reason: 'permanent-blocklist',
        rule: `permanent-hostname:${hostname}`,
      });
    }

    // ── 3. Hostname admin blocklist ──────────────────────────────
    if (hostnameMatchesAny(hostname, snapshot.blockedHosts, !snapshot.strictMode)) {
      this.logger.warn(`Rejecting URL(${url.href}) with admin-blocked hostname: ${hostname}`);

      return this.reject({
        hostname,
        reason: 'admin-blocklist',
        rule: `admin-blocklist:host:${hostname}`,
      });
    }

    // ── 4. DNS resolution ────────────────────────────────────────
    let resolved: ResolvedAddress[];
    try {
      resolved = await this.dns.resolveAll(hostname);
    } catch (err) {
      this.logger.error(
        `DNS resolution failed for hostname ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
        {
          hostname,
          error: err instanceof Error ? err.stack : String(err),
        },
      );

      if (err instanceof DnsResolutionError) {
        return this.reject({
          hostname,
          reason: 'dns-failure',
          rule: 'dns-failure',
        });
      }

      throw err;
    }

    if (resolved.length === 0) {
      this.logger.warn(`DNS resolution for hostname ${hostname} returned no records`);

      return this.reject({
        hostname,
        reason: 'dns-failure',
        rule: 'dns-empty',
      });
    }

    // Parse admin lists once per evaluation. Invalid entries are silently
    // skipped; the admin controller's DTO validation prevents writes of
    // malformed entries, and policy-load logs flag any that slipped through.
    const adminBlockedCidrs = parseCidrList(snapshot.blockedCidrs);
    const adminAllowedCidrs = parseCidrList(snapshot.allowedCidrs);
    const hostOnAllowedList = hostnameMatchesAny(hostname, snapshot.allowedHosts, !snapshot.strictMode);

    // ── 5. Per-IP evaluation ─────────────────────────────────────
    // First pass: anything that fails permanent or admin block lists
    // causes immediate whole-hostname rejection regardless of allowlist.
    for (const addr of resolved) {
      const ip = parseIp(addr.address);
      if (!ip) {
        // Should never happen — Node returned an unparseable IP.
        this.logger.error(`Unparseable IP address returned by Node: ${addr.address}`, {
          hostname,
          address: addr.address,
        });

        return this.reject({
          hostname,
          reason: 'dns-failure',
          ip: addr.address,
          rule: 'dns-malformed',
        });
      }

      const permanentHit = findContainingCidr(PERMANENT_BLOCKED_PARSED, ip);
      if (permanentHit) {
        this.logger.warn(
          `Rejecting hostname ${hostname} with resolved IP ${ip.canonical} on permanent blocklist (rule: ${cidrLabel(permanentHit)})`,
          {
            hostname,
            ip: ip.canonical,
            rule: `permanent-cidr:${cidrLabel(permanentHit)}`,
          },
        );

        return this.reject({
          hostname,
          reason: ip.wasIpv4Mapped ? 'ipv4-mapped-evasion' : 'permanent-blocklist',
          ip: ip.canonical,
          rule: ip.wasIpv4Mapped ? `ipv4-mapped-evasion:permanent` : `permanent-cidr:${cidrLabel(permanentHit)}`,
        });
      }

      const adminBlockHit = findContainingCidr(adminBlockedCidrs, ip);
      if (adminBlockHit) {
        this.logger.warn(
          `Rejecting hostname ${hostname} with resolved IP ${ip.canonical} on admin blocklist (rule: ${cidrLabel(adminBlockHit)})`,
          {
            hostname,
            ip: ip.canonical,
            rule: `admin-blocklist:cidr:${cidrLabel(adminBlockHit)}`,
          },
        );

        return this.reject({
          hostname,
          reason: 'admin-blocklist',
          ip: ip.canonical,
          rule: `admin-blocklist:cidr:${cidrLabel(adminBlockHit)}`,
        });
      }
    }

    // Second pass: each IP must either be on the allowlist or pass the
    // default private-range check. Multi-record reject still applies —
    // a single private IP poisons the whole record set even if siblings
    // are public.
    let pinnedAddress: ResolvedAddress | null = null;
    let pinnedIp: ParsedIp | null = null;

    for (const addr of resolved) {
      const ip = parseIp(addr.address)!; // safe — already validated above

      const adminAllowHit = hostOnAllowedList || findContainingCidr(adminAllowedCidrs, ip) !== null;

      if (!adminAllowHit) {
        const privateHit = findContainingCidr(DEFAULT_PRIVATE_PARSED, ip);
        if (privateHit) {
          const label = cidrLabel(privateHit);

          this.logger.warn(
            `Rejecting hostname ${hostname} with resolved IP ${ip.canonical} in private range (rule: ${label})`,
            {
              hostname,
              ip: ip.canonical,
              rule: `default-private:cidr:${label}`,
            },
          );

          return this.reject({
            hostname,
            reason: ip.wasIpv4Mapped ? 'ipv4-mapped-evasion' : 'private-range',
            ip: ip.canonical,
            rule: ip.wasIpv4Mapped ? `ipv4-mapped-evasion:private:${label}` : `default-private:cidr:${label}`,
          });
        }
      }

      // This IP passed. Pin the first one we encounter — DnsResolver
      // returned them in OS-native order, so we honor that ordering.
      if (pinnedAddress === null) {
        pinnedAddress = addr;
        pinnedIp = ip;
      }
    }

    // Unreachable — `resolved` is non-empty and either a reject fired or
    // pinnedAddress was set. Defensive check for type narrowing.
    if (pinnedAddress === null || pinnedIp === null) {
      this.logger.error(`Internal error: no allowed IP found for hostname ${hostname} despite passing checks`, {
        hostname,
        resolved: resolved.map((r) => r.address),
      });

      return this.reject({
        hostname,
        reason: 'dns-failure',
        rule: 'unreachable',
      });
    }

    return {
      allowed: true,
      hostname,
      pinnedIp: pinnedIp.canonical,
      pinnedFamily: pinnedIp.family,
    } satisfies IpPolicyDecision;
  }

  private reject(reject: Omit<IpPolicyReject, 'allowed'>): IpPolicyReject {
    return { allowed: false, ...reject };
  }
}

function cidrLabel(cidr: ParsedCidr): string {
  // Compact label for diagnostics — `family:prefixLength`. The exact bytes
  // aren't logged because they'd require re-stringification work; the
  // prefix length plus family is enough for an admin reading the audit log
  // to identify which rule fired without leaking the full address space.
  return `ipv${cidr.family}/${cidr.prefixLength}`;
}
