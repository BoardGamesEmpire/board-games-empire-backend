import { hostnameMatchesAny } from './hostname-matcher';

describe('hostnameMatchesAny', () => {
  describe('exact match', () => {
    it('matches when hostname equals an entry', () => {
      expect(hostnameMatchesAny('example.com', ['example.com'], false)).toBe(true);
    });

    it('does not match when hostname differs from all entries', () => {
      expect(hostnameMatchesAny('evil.com', ['example.com', 'other.com'], false)).toBe(false);
    });

    it('is case-insensitive (entries are lowered; hostname assumed already lowered)', () => {
      // Entry casing — function lowers entries before compare
      expect(hostnameMatchesAny('example.com', ['EXAMPLE.COM'], false)).toBe(true);
    });

    it('matches against an empty list as false', () => {
      expect(hostnameMatchesAny('example.com', [], false)).toBe(false);
    });
  });

  describe('strict mode (allowWildcards=false)', () => {
    it('ignores wildcard entries — they never match', () => {
      expect(hostnameMatchesAny('a.example.com', ['*.example.com'], false)).toBe(false);
    });

    it('still matches exact entries when wildcards are mixed in', () => {
      expect(hostnameMatchesAny('foo.com', ['*.example.com', 'foo.com'], false)).toBe(true);
    });
  });

  describe('wildcard mode (allowWildcards=true)', () => {
    it('matches a subdomain via *.suffix', () => {
      expect(hostnameMatchesAny('a.example.com', ['*.example.com'], true)).toBe(true);
    });

    it('matches deeply nested subdomains', () => {
      expect(hostnameMatchesAny('a.b.c.example.com', ['*.example.com'], true)).toBe(true);
    });

    it('does NOT match the apex domain via *.suffix', () => {
      expect(hostnameMatchesAny('example.com', ['*.example.com'], true)).toBe(false);
    });

    it('does NOT match a hostname that ends in suffix but is not a subdomain (hostname-confusion guard)', () => {
      // The critical security test — `evil-example.com` ends in `example.com`
      // textually but is not a subdomain. Right-anchored matching with the
      // leading `.` anchor rejects this.
      expect(hostnameMatchesAny('evil-example.com', ['*.example.com'], true)).toBe(false);
    });

    it('still matches exact entries when wildcards are enabled', () => {
      expect(hostnameMatchesAny('example.com', ['example.com'], true)).toBe(true);
    });
  });
});
