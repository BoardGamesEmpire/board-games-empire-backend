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
