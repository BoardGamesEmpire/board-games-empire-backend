import type { DnsResolver, ResolvedAddress } from '../dns/dns-resolver.interface';
import { DnsResolutionError } from '../dns/dns-resolver.interface';
import type { SafeHttpPolicySnapshot } from '../interfaces/safe-http-policy-snapshot.interface';
import { IpPolicyService } from './ip-policy.service';

/**
 * In-memory DnsResolver fake. Tests preload `responses` with hostname-to-IP
 * mappings; `resolveAll` returns them. Unknown hostnames throw `DnsResolutionError`,
 * matching the production `DefaultDnsResolver` failure contract.
 */
class FakeDnsResolver implements DnsResolver {
  readonly responses = new Map<string, ResolvedAddress[]>();

  async resolveAll(hostname: string): Promise<ResolvedAddress[]> {
    const entry = this.responses.get(hostname);
    if (!entry) {
      throw new DnsResolutionError(hostname, new Error('NXDOMAIN (fake)'));
    }
    return entry;
  }

  set(hostname: string, addresses: ResolvedAddress[]): void {
    this.responses.set(hostname, addresses);
  }
}

function buildSnapshot(overrides: Partial<SafeHttpPolicySnapshot> = {}): SafeHttpPolicySnapshot {
  return {
    defaultTimeoutMs: 10_000,
    defaultMaxRedirects: 5,
    strictMode: true,
    allowedHosts: [],
    allowedCidrs: [],
    blockedHosts: [],
    blockedCidrs: [],
    ...overrides,
  };
}

const v4 = (address: string): ResolvedAddress => ({ address, family: 4 });
const v6 = (address: string): ResolvedAddress => ({ address, family: 6 });

describe('IpPolicyService', () => {
  let dns: FakeDnsResolver;
  let service: IpPolicyService;

  beforeEach(() => {
    dns = new FakeDnsResolver();
    service = new IpPolicyService(dns);
  });

  describe('scheme', () => {
    it.each(['ftp:', 'file:', 'gopher:', 'data:'])('rejects %s scheme', async (proto) => {
      const url = new URL(`${proto}//example.com/x`);
      const decision = await service.evaluate(url, buildSnapshot());
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe('invalid-scheme');
      }
    });

    it('allows http://', async () => {
      dns.set('example.com', [v4('8.8.8.8')]);
      const decision = await service.evaluate(new URL('http://example.com/'), buildSnapshot());
      expect(decision.allowed).toBe(true);
    });

    it('allows https://', async () => {
      dns.set('example.com', [v4('8.8.8.8')]);
      const decision = await service.evaluate(new URL('https://example.com/'), buildSnapshot());
      expect(decision.allowed).toBe(true);
    });
  });

  describe('permanent hostname blocklist', () => {
    it.each([
      'metadata',
      'metadata.google.internal',
      'metadata.goog',
      'metadata.azure.com',
      'metadata.ec2.internal',
      'instance-data',
      'instance-data.ec2.internal',
    ])('rejects %s', async (hostname) => {
      const decision = await service.evaluate(new URL(`http://${hostname}/x`), buildSnapshot());
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe('permanent-blocklist');
        expect(decision.rule).toContain('permanent-hostname');
      }
    });

    it('cannot be overridden by admin allowlist', async () => {
      const decision = await service.evaluate(
        new URL('http://metadata.google.internal/'),
        buildSnapshot({ allowedHosts: ['metadata.google.internal'] }),
      );
      expect(decision.allowed).toBe(false);
    });
  });

  describe('permanent IP blocklist', () => {
    it('rejects AWS/GCP IMDS IPv4 (169.254.169.254)', async () => {
      dns.set('example.com', [v4('169.254.169.254')]);
      const decision = await service.evaluate(new URL('http://example.com/'), buildSnapshot());
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe('permanent-blocklist');
        expect(decision.ip).toBe('169.254.169.254');
      }
    });

    it('rejects ECS task metadata IPv4 (169.254.170.2)', async () => {
      dns.set('example.com', [v4('169.254.170.2')]);
      const decision = await service.evaluate(new URL('http://example.com/'), buildSnapshot());
      expect(decision.allowed).toBe(false);
    });

    it('rejects unspecified address 0.0.0.0', async () => {
      dns.set('example.com', [v4('0.0.0.0')]);
      const decision = await service.evaluate(new URL('http://example.com/'), buildSnapshot());
      expect(decision.allowed).toBe(false);
    });

    it('rejects broadcast 255.255.255.255', async () => {
      dns.set('example.com', [v4('255.255.255.255')]);
      const decision = await service.evaluate(new URL('http://example.com/'), buildSnapshot());
      expect(decision.allowed).toBe(false);
    });

    it('cannot be overridden by admin allowlist', async () => {
      dns.set('example.com', [v4('169.254.169.254')]);
      const decision = await service.evaluate(
        new URL('http://example.com/'),
        buildSnapshot({ allowedCidrs: ['169.254.0.0/16'] }),
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe('permanent-blocklist');
      }
    });
  });

  describe('default private-range deny', () => {
    it.each([
      ['IPv4 loopback', v4('127.0.0.1')],
      ['IPv4 private RFC1918 10/8', v4('10.5.6.7')],
      ['IPv4 private RFC1918 172.16/12', v4('172.20.0.1')],
      ['IPv4 private RFC1918 192.168/16', v4('192.168.1.1')],
      ['IPv4 CGNAT 100.64/10', v4('100.64.0.5')],
      ['IPv4 multicast 224/4', v4('224.0.0.1')],
      ['IPv6 loopback ::1', v6('::1')],
      ['IPv6 link-local fe80::/10', v6('fe80::1')],
      ['IPv6 ULA fc00::/7', v6('fd00::5')],
      ['IPv6 multicast ff00::/8', v6('ff00::1')],
    ])('rejects %s', async (_label, address) => {
      dns.set('example.com', [address]);
      const decision = await service.evaluate(new URL('http://example.com/'), buildSnapshot());
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe('private-range');
      }
    });

    it('allows when admin CIDR allowlist covers the IP', async () => {
      dns.set('jenkins.local', [v4('10.0.0.5')]);
      const decision = await service.evaluate(
        new URL('http://jenkins.local/'),
        buildSnapshot({ allowedCidrs: ['10.0.0.0/8'] }),
      );
      expect(decision.allowed).toBe(true);
      if (decision.allowed) {
        expect(decision.pinnedIp).toBe('10.0.0.5');
      }
    });

    it('allows when admin hostname allowlist matches', async () => {
      dns.set('jenkins.local', [v4('10.0.0.5')]);
      const decision = await service.evaluate(
        new URL('http://jenkins.local/'),
        buildSnapshot({ allowedHosts: ['jenkins.local'] }),
      );
      expect(decision.allowed).toBe(true);
    });
  });

  describe('admin blocklist', () => {
    it('rejects on host match even when IP is public', async () => {
      dns.set('blocked.example.com', [v4('8.8.8.8')]);
      const decision = await service.evaluate(
        new URL('http://blocked.example.com/'),
        buildSnapshot({ blockedHosts: ['blocked.example.com'] }),
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe('admin-blocklist');
      }
    });

    it('rejects on CIDR match even when not in private ranges', async () => {
      dns.set('upstream.example.com', [v4('203.0.113.5')]);
      const decision = await service.evaluate(
        new URL('http://upstream.example.com/'),
        buildSnapshot({ blockedCidrs: ['203.0.113.0/24'] }),
      );
      expect(decision.allowed).toBe(false);
    });

    it('wins over allowlist when both match', async () => {
      dns.set('h.example.com', [v4('10.0.0.5')]);
      const decision = await service.evaluate(
        new URL('http://h.example.com/'),
        buildSnapshot({
          blockedCidrs: ['10.0.0.0/8'],
          allowedCidrs: ['10.0.0.0/8'],
        }),
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe('admin-blocklist');
      }
    });
  });

  describe('IPv4-mapped IPv6 evasion', () => {
    it('rejects ::ffff:127.0.0.1 with ipv4-mapped-evasion reason', async () => {
      dns.set('example.com', [v6('::ffff:127.0.0.1')]);
      const decision = await service.evaluate(new URL('http://example.com/'), buildSnapshot());
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe('ipv4-mapped-evasion');
      }
    });

    it('rejects ::ffff:10.0.0.1 with ipv4-mapped-evasion', async () => {
      dns.set('example.com', [v6('::ffff:10.0.0.1')]);
      const decision = await service.evaluate(new URL('http://example.com/'), buildSnapshot());
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe('ipv4-mapped-evasion');
      }
    });

    it('allows ::ffff:8.8.8.8 (mapped public IP — not evasion)', async () => {
      dns.set('example.com', [v6('::ffff:8.8.8.8')]);
      const decision = await service.evaluate(new URL('http://example.com/'), buildSnapshot());
      expect(decision.allowed).toBe(true);
      if (decision.allowed) {
        // Pinned IP is the normalized v4 form, not the v6 string.
        expect(decision.pinnedIp).toBe('8.8.8.8');
        expect(decision.pinnedFamily).toBe(4);
      }
    });
  });

  describe('multi-record reject', () => {
    it('rejects when ANY resolved IP is in a deny range', async () => {
      // Attacker controls DNS, returns one public + one loopback. We reject.
      dns.set('attacker.example.com', [v4('8.8.8.8'), v4('127.0.0.1')]);
      const decision = await service.evaluate(new URL('http://attacker.example.com/'), buildSnapshot());
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        // First-pass perm/admin block-list scan didn't find anything; the
        // second-pass private-range check is what fires here.
        expect(decision.reason).toBe('private-range');
      }
    });

    it('rejects whole hostname when any record is on the permanent blocklist', async () => {
      dns.set('example.com', [v4('8.8.8.8'), v4('169.254.169.254')]);
      const decision = await service.evaluate(new URL('http://example.com/'), buildSnapshot());
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe('permanent-blocklist');
      }
    });

    it('allows all-public records and pins to the first', async () => {
      dns.set('example.com', [v4('8.8.8.8'), v4('1.1.1.1')]);
      const decision = await service.evaluate(new URL('http://example.com/'), buildSnapshot());
      expect(decision.allowed).toBe(true);
      if (decision.allowed) {
        expect(decision.pinnedIp).toBe('8.8.8.8');
      }
    });
  });

  describe('DNS failure', () => {
    it('rejects with dns-failure reason when resolution throws', async () => {
      // dns.responses has no entry for `nx.example.com` — FakeDnsResolver throws.
      const decision = await service.evaluate(new URL('http://nx.example.com/'), buildSnapshot());
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe('dns-failure');
      }
    });
  });

  describe('successful pinning', () => {
    it('returns the first resolved IP as pinnedIp', async () => {
      dns.set('example.com', [v4('8.8.8.8'), v4('8.8.4.4')]);
      const decision = await service.evaluate(new URL('http://example.com/'), buildSnapshot());
      if (decision.allowed) {
        expect(decision.pinnedIp).toBe('8.8.8.8');
        expect(decision.pinnedFamily).toBe(4);
        expect(decision.hostname).toBe('example.com');
      } else {
        fail('expected allow');
      }
    });

    it('lowercases the hostname for matching and reporting', async () => {
      dns.set('example.com', [v4('8.8.8.8')]);
      const decision = await service.evaluate(new URL('http://EXAMPLE.COM/'), buildSnapshot());
      if (decision.allowed) {
        expect(decision.hostname).toBe('example.com');
      } else {
        fail('expected allow');
      }
    });
  });
});
