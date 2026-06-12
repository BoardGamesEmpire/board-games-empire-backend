import { cidrContains, findContainingCidr, parseCidr, parseCidrList } from './cidr';
import { parseIp } from './ip';

describe('parseCidr', () => {
  it('parses IPv4 CIDR notation', () => {
    const cidr = parseCidr('10.0.0.0/8');
    expect(cidr).not.toBeNull();
    expect(cidr?.family).toBe(4);
    expect(cidr?.prefixLength).toBe(8);
    expect(cidr?.baseBytes).toEqual(new Uint8Array([10, 0, 0, 0]));
  });

  it('parses IPv6 CIDR notation', () => {
    const cidr = parseCidr('fc00::/7');
    expect(cidr?.family).toBe(6);
    expect(cidr?.prefixLength).toBe(7);
  });

  it('canonicalizes base bytes — zeroes host portion beyond the prefix', () => {
    // 10.5.6.7/8 → base should be 10.0.0.0
    const cidr = parseCidr('10.5.6.7/8');
    expect(cidr?.baseBytes).toEqual(new Uint8Array([10, 0, 0, 0]));
  });

  it('accepts /32 IPv4 (single-host CIDR)', () => {
    const cidr = parseCidr('10.0.0.5/32');
    expect(cidr?.baseBytes).toEqual(new Uint8Array([10, 0, 0, 5]));
  });

  it('accepts /128 IPv6 (single-host CIDR)', () => {
    const cidr = parseCidr('::1/128');
    expect(cidr?.prefixLength).toBe(128);
  });

  it('rejects bare IP without prefix', () => {
    expect(parseCidr('10.0.0.5')).toBeNull();
  });

  it('rejects negative prefix', () => {
    expect(parseCidr('10.0.0.0/-1')).toBeNull();
  });

  it('rejects prefix exceeding family max', () => {
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('::/129')).toBeNull();
  });

  it('rejects non-integer prefix', () => {
    expect(parseCidr('10.0.0.0/abc')).toBeNull();
  });

  it('rejects malformed address', () => {
    expect(parseCidr('not-an-ip/8')).toBeNull();
  });
});

describe('cidrContains', () => {
  it('matches IPv4 inside its CIDR', () => {
    const cidr = parseCidr('10.0.0.0/8')!;
    const ip = parseIp('10.5.6.7')!;
    expect(cidrContains(cidr, ip)).toBe(true);
  });

  it('rejects IPv4 outside its CIDR', () => {
    const cidr = parseCidr('10.0.0.0/8')!;
    const ip = parseIp('11.0.0.1')!;
    expect(cidrContains(cidr, ip)).toBe(false);
  });

  it('matches at the prefix boundary', () => {
    const cidr = parseCidr('172.16.0.0/12')!;
    expect(cidrContains(cidr, parseIp('172.16.0.0')!)).toBe(true);
    expect(cidrContains(cidr, parseIp('172.31.255.255')!)).toBe(true);
    expect(cidrContains(cidr, parseIp('172.32.0.0')!)).toBe(false);
    expect(cidrContains(cidr, parseIp('172.15.255.255')!)).toBe(false);
  });

  it('matches IPv6 inside its CIDR', () => {
    const cidr = parseCidr('fc00::/7')!;
    expect(cidrContains(cidr, parseIp('fc00::1')!)).toBe(true);
    expect(cidrContains(cidr, parseIp('fd00::5')!)).toBe(true);
  });

  it('rejects IPv6 outside its CIDR', () => {
    const cidr = parseCidr('fc00::/7')!;
    expect(cidrContains(cidr, parseIp('2001:db8::1')!)).toBe(false);
  });

  it('family mismatch is non-match', () => {
    const cidr = parseCidr('10.0.0.0/8')!;
    const ipv6 = parseIp('::1')!;
    expect(cidrContains(cidr, ipv6)).toBe(false);
  });

  it('handles /32 single-host match', () => {
    const cidr = parseCidr('169.254.169.254/32')!;
    expect(cidrContains(cidr, parseIp('169.254.169.254')!)).toBe(true);
    expect(cidrContains(cidr, parseIp('169.254.169.253')!)).toBe(false);
  });

  it('handles /0 — matches everything in family', () => {
    const v4 = parseCidr('0.0.0.0/0')!;
    expect(cidrContains(v4, parseIp('1.2.3.4')!)).toBe(true);
    expect(cidrContains(v4, parseIp('255.255.255.255')!)).toBe(true);
  });
});

describe('parseCidrList', () => {
  it('returns only valid entries; silently drops invalid ones', () => {
    const result = parseCidrList(['10.0.0.0/8', 'not-a-cidr', 'fc00::/7']);
    expect(result).toHaveLength(2);
    expect(result[0].family).toBe(4);
    expect(result[1].family).toBe(6);
  });

  it('returns empty array for all-invalid input', () => {
    expect(parseCidrList(['bad', 'also-bad'])).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(parseCidrList([])).toEqual([]);
  });
});

describe('findContainingCidr', () => {
  it('returns the first matching CIDR', () => {
    const cidrs = parseCidrList(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']);
    const ip = parseIp('192.168.1.1')!;
    const result = findContainingCidr(cidrs, ip);
    expect(result?.prefixLength).toBe(16);
  });

  it('returns null when no CIDR matches', () => {
    const cidrs = parseCidrList(['10.0.0.0/8']);
    const ip = parseIp('8.8.8.8')!;
    expect(findContainingCidr(cidrs, ip)).toBeNull();
  });
});
