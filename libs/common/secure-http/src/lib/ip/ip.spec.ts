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
  });
});
