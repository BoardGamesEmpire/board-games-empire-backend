import { IsCidrConstraint, IsHostnameOrWildcardConstraint } from './validators';

describe('IsHostnameOrWildcardConstraint', () => {
  const c = new IsHostnameOrWildcardConstraint();

  describe('valid', () => {
    it.each([
      'example.com',
      'jenkins.local',
      'a.b.c.example.com',
      '*.example.com',
      '*.internal.local',
      'jenkins', // single-label hostname, internal-network common case
    ])('accepts %s', (input) => {
      expect(c.validate(input)).toBe(true);
    });
  });

  describe('invalid', () => {
    it.each([
      '', // empty string
      '*.', // wildcard with no suffix
      'example..com', // double dot
      '-bad.example.com', // label starts with hyphen
      'example.com-', // label ends with hyphen
      'has spaces.com', // spaces
      'has_underscore.com', // explicitly disallow underscores
    ])('rejects %s', (input) => {
      expect(c.validate(input)).toBe(false);
    });

    it('rejects non-string input', () => {
      expect(c.validate(42)).toBe(false);
      expect(c.validate(null)).toBe(false);
      expect(c.validate(undefined)).toBe(false);
      expect(c.validate({})).toBe(false);
    });
  });
});

describe('IsCidrConstraint', () => {
  const c = new IsCidrConstraint();

  describe('valid', () => {
    it.each([
      '10.0.0.0/8',
      '192.168.1.0/24',
      '172.16.0.0/12',
      '0.0.0.0/0',
      '169.254.169.254/32',
      'fc00::/7',
      'fe80::/10',
      '::1/128',
    ])('accepts %s', (input) => {
      expect(c.validate(input)).toBe(true);
    });
  });

  describe('invalid', () => {
    it.each([
      '10.0.0.5', // bare IP without prefix
      '10.0.0.0/33', // prefix exceeds family max
      '::1/129', // prefix exceeds family max
      '10.0.0.0/-1', // negative prefix
      '10.0.0.0/abc', // non-integer prefix
      'not-an-ip/8', // bad address
      // #1519: junk after the prefix digits was read as the digits alone
      '10.0.0.0/8abc',
      '10.0.0.0/ 8',
      '10.0.0.0/8.5',
      '10.0.0.0/0x10', // was read as /0, every IPv4 address
      '10.0.0.0/8/9',
      'fc00::/7x',
      '10.0.0.0/00', // a leading zero: would be read as /0
      '10.0.0.0/08',
      'fe80::1%eth0/64', // IPv6 zone ID, which no rule can match on (#1525)
      'fe80::1/64%eth0', // the same zone, written after the prefix (#1525)
      '',
    ])('rejects %s', (input) => {
      expect(c.validate(input)).toBe(false);
    });

    it('rejects non-string input', () => {
      expect(c.validate(42)).toBe(false);
      expect(c.validate(null)).toBe(false);
    });
  });
});
