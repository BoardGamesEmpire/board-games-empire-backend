import { parseIp } from './ip';

describe('parseIp', () => {
  describe('IPv4', () => {
    it('parses a dotted-quad address', () => {
      const result = parseIp('10.0.0.1');
      expect(result).toEqual({
        family: 4,
        canonical: '10.0.0.1',
        bytes: new Uint8Array([10, 0, 0, 1]),
        wasIpv4Mapped: false,
      });
    });

    it('parses 0.0.0.0', () => {
      const result = parseIp('0.0.0.0');
      expect(result?.family).toBe(4);
      expect(result?.bytes).toEqual(new Uint8Array([0, 0, 0, 0]));
    });

    it('parses 255.255.255.255', () => {
      const result = parseIp('255.255.255.255');
      expect(result?.bytes).toEqual(new Uint8Array([255, 255, 255, 255]));
    });

    it('rejects malformed input', () => {
      expect(parseIp('999.999.999.999')).toBeNull();
      expect(parseIp('10.0.0')).toBeNull();
      expect(parseIp('not-an-ip')).toBeNull();
      expect(parseIp('')).toBeNull();
    });
  });

  describe('IPv6', () => {
    it('parses a fully-expanded IPv6 address', () => {
      const result = parseIp('2001:db8:0:0:0:0:0:1');
      expect(result?.family).toBe(6);
      expect(result?.bytes[0]).toBe(0x20);
      expect(result?.bytes[1]).toBe(0x01);
      expect(result?.bytes[15]).toBe(0x01);
    });

    it('parses IPv6 loopback ::1', () => {
      const result = parseIp('::1');
      expect(result?.family).toBe(6);
      const expected = new Uint8Array(16);
      expected[15] = 1;
      expect(result?.bytes).toEqual(expected);
    });

    it('parses IPv6 unspecified ::', () => {
      const result = parseIp('::');
      expect(result?.family).toBe(6);
      expect(result?.bytes).toEqual(new Uint8Array(16));
    });

    it('lowercases hex digits', () => {
      const result = parseIp('FE80::1');
      expect(result?.canonical).toBe('fe80::1');
    });

    // #1525: DNS results and peer addresses can carry a zone; the address
    // still has to read as itself so the fe80::/10 block keeps applying.
    // Node's isIPv6 lets a zone hold '.' and ':' (a VLAN interface such as
    // eth0.100), which must not be read as an IPv4 tail or an extra group.
    it.each([
      ['fe80::1%eth0', 'fe80::1'],
      ['fe80::1%eth0.100', 'fe80::1'],
      ['fe80::1:2:3:4%br-1.5', 'fe80::1:2:3:4'],
      ['fe80::abcd%a:b', 'fe80::abcd'],
      ['::1%lo.0', '::1'],
    ])('reads the scoped address %s as %s, without the zone ID (#1525)', (input, canonical) => {
      const result = parseIp(input);
      expect(result?.family).toBe(6);
      expect(result?.canonical).toBe(canonical);
    });

    it('reads a scoped IPv4-mapped address as its IPv4 address (#1525)', () => {
      const result = parseIp('::ffff:10.0.0.1%eth0.5');
      expect(result?.family).toBe(4);
      expect(result?.canonical).toBe('10.0.0.1');
      expect(result?.wasIpv4Mapped).toBe(true);
    });
  });

  describe('IPv4-mapped IPv6', () => {
    it('normalizes ::ffff:10.0.0.1 to IPv4 form and flags it', () => {
      const result = parseIp('::ffff:10.0.0.1');
      expect(result).toEqual({
        family: 4,
        canonical: '10.0.0.1',
        bytes: new Uint8Array([10, 0, 0, 1]),
        wasIpv4Mapped: true,
      });
    });

    it('normalizes ::ffff:127.0.0.1 to IPv4 loopback form', () => {
      const result = parseIp('::ffff:127.0.0.1');
      expect(result?.canonical).toBe('127.0.0.1');
      expect(result?.wasIpv4Mapped).toBe(true);
    });

    it('preserves wasIpv4Mapped: false for non-mapped IPv6 loopback', () => {
      const result = parseIp('::1');
      expect(result?.wasIpv4Mapped).toBe(false);
    });

    it('compresses the longest zero run to :: (RFC 5952)', () => {
      expect(parseIp('2001:db8:0:0:0:0:0:1')?.canonical).toBe('2001:db8::1');
    });

    it('canonicalizes all-zeros address to ::', () => {
      expect(parseIp('::')?.canonical).toBe('::');
    });

    it('canonicalizes loopback to ::1', () => {
      expect(parseIp('::1')?.canonical).toBe('::1');
    });

    it('strips leading zeros within each group', () => {
      expect(parseIp('2001:0db8::0001')?.canonical).toBe('2001:db8::1');
    });

    it('picks the leftmost run when zero-run lengths tie', () => {
      // Two equal runs of 2 zeros — leftmost wins.
      expect(parseIp('1:0:0:1:0:0:1:1')?.canonical).toBe('1::1:0:0:1:1');
    });
  });
});
