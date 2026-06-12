import { Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { IpFamily } from '../ip';
import { DnsResolutionError, type DnsResolver, type ResolvedAddress } from './dns-resolver.interface';

/**
 * Default `DnsResolver` implementation backed by `dns.promises.lookup`.
 *
 * Configured with `{ all: true, verbatim: true }`:
 *   - `all`     — return every A and AAAA record, not just one. The
 *                 multi-record-reject rule in `IpPolicyService` needs to
 *                 see them all.
 *   - `verbatim`— preserve the order returned by the OS resolver. Without
 *                 this, Node sorts IPv4 ahead of IPv6, which can mask
 *                 ordering bugs in tests.
 *
 * Goes through `getaddrinfo` rather than `dns.resolve4`/`resolve6` for
 * `/etc/hosts` and NSS support — admins on self-hosted setups commonly
 * map internal hostnames there, and that should keep working.
 */
@Injectable()
export class DefaultDnsResolver implements DnsResolver {
  async resolveAll(hostname: string): Promise<ResolvedAddress[]> {
    try {
      const addresses = await lookup(hostname, { all: true, verbatim: true });
      return addresses.map((a) => ({ address: a.address, family: a.family as IpFamily }));
    } catch (err) {
      throw new DnsResolutionError(hostname, err instanceof Error ? err : new Error(String(err)));
    }
  }
}
