import { allowsEveryHost, createHostRule, type ServerNames } from './host-rule';

describe('createHostRule (#977)', () => {
  const names: ServerNames = {
    publicUrl: 'https://bge.example',
    trustedOrigins: [
      'http://localhost:{PORT}',
      'https://*.preview.example',
      'myapp://ignored.example',
      'scrape.example',
    ],
    mediaBaseUrl: 'https://media.example/api',
  };
  const rule = createHostRule(names);

  describe("the server's own names, localhost, IP literals and a missing Host", () => {
    it.each([
      'bge.example',
      'bge.example:8443',
      'BGE.Example',
      'bge.example.',
      'media.example',
      'scrape.example',
      'pr-1.preview.example',
      'localhost',
      'localhost:5173',
      '127.0.0.1',
      '127.0.0.1:33333',
      '203.0.113.9',
      '[::1]',
      '[::1]:33333',
      '[2001:db8::7]:80',
      undefined,
      '',
    ])('lets %s through', (host) => {
      expect(rule(host)).toBe(true);
    });
  });

  describe("a name that is not the server's", () => {
    it.each([
      'evil.example',
      'bge.example.evil.example',
      'evilbge.example',
      '127.0.0.1.evil.example',
      'localhost.evil.example',
      'preview.example',
      'ignored.example',
      'api',
      'api:33333',
    ])('refuses %s', (host) => {
      expect(rule(host)).toBe(false);
    });
  });

  describe('a malformed Host', () => {
    it.each([
      'a b',
      'x@bge.example',
      '[::1',
      '[zz]:80',
      '[127.0.0.1]',
      '::1',
      'bge.example:',
      'bge.example:abc',
      ':80',
      '.',
      'x'.repeat(2000),
    ])('refuses %s', (host) => {
      expect(rule(host)).toBe(false);
    });

    // A wildcard entry must not turn these into passes: the pattern `*` matches
    // any text, and only the reading of the Host keeps it to well-formed names.
    it.each(['a b', 'x@bge.example', '[zz]:80', '.'])('refuses %s even with a bare * entry', (host) => {
      expect(createHostRule({ ...names, trustedOrigins: ['*'] })(host)).toBe(false);
    });
  });

  describe('an entry the operator wrote in another form', () => {
    const allowing = (entry: string) => createHostRule({ ...names, trustedOrigins: [entry] });

    it('compares the entry without the case or the trailing dot it was written with', () => {
      expect(allowing('HTTPS://Scrape.Example.')('scrape.example')).toBe(true);
    });

    it('reads a bare service name with a port, the form a scraper targets', () => {
      expect(allowing('api:33333')('api:33333')).toBe(true);
    });

    it('treats ? as one character, as better-auth does', () => {
      const rule = allowing('https://pr-?.preview.example');

      expect(rule('pr-1.preview.example')).toBe(true);
      expect(rule('pr-12.preview.example')).toBe(false);
    });

    it('takes dots in an entry literally', () => {
      expect(allowing('https://scrape.example')('scrapeXexample')).toBe(false);
    });

    // better-auth matches a wildcard against the whole origin, so an entry whose
    // scheme is a wildcard does name http and https hosts.
    it.each(['*://scrape.example', 'http*://scrape.example', 'http?://scrape.example'])(
      'reads %s as naming its host, because the scheme covers http or https',
      (entry) => {
        expect(allowing(entry)('scrape.example')).toBe(true);
      },
    );

    it.each(['myapp://scrape.example', 'my*://scrape.example'])(
      'reads %s as naming no host, because the scheme covers neither',
      (entry) => {
        expect(allowing(entry)('scrape.example')).toBe(false);
      },
    );

    // RFC 8252's redirect form for a native app. `com.example.app` reads like a
    // name, and whoever owns `example.app` could rebind with it.
    it.each([
      ['com.example.app:/oauth/callback', 'com.example.app'],
      ['myapp:callback', 'myapp'],
    ])('reads %s as naming no host, because it has a scheme and no port', (entry, host) => {
      expect(allowing(entry)(host)).toBe(false);
    });

    it.each([
      ['localhost:{PORT}/', 'localhost'],
      ['scrape.example:*', 'scrape.example'],
      ['scrape.example/metrics', 'scrape.example'],
    ])('reads %s as a host, because what follows it is a port or a path', (entry, host) => {
      expect(allowing(entry)(host)).toBe(true);
    });

    it('gives an empty entry no meaning', () => {
      expect(allowing('')('evil.example')).toBe(false);
    });

    it.each(['https://ops@scrape.example', 'https://ops:secret@scrape.example:8443/path'])(
      'reads the host in %s, past the user details',
      (entry) => {
        const rule = allowing(entry);

        expect(rule('scrape.example')).toBe(true);
        expect(rule('ops')).toBe(false);
      },
    );

    it('keeps a path with an @ out of the host', () => {
      expect(allowing('scrape.example/@me')('scrape.example')).toBe(true);
    });

    // A URL parser ends the host at a fragment or a backslash, so an @ past
    // either is no user details.
    it.each(['https://scrape.example#@evil.example', 'https://scrape.example\\@evil.example'])(
      'reads the host in %s before the @',
      (entry) => {
        const rule = allowing(entry);

        expect(rule('scrape.example')).toBe(true);
        expect(rule('evil.example')).toBe(false);
      },
    );

    // Here ? is a wildcard, not a query, so the authority runs on past it. User
    // details can't hold a ?, so the @ doesn't end them, and the entry names no
    // host at all.
    it('reads no host past an @ that follows a ?', () => {
      expect(allowing('https://scrape.example?return=@evil.example')('evil.example')).toBe(false);
    });

    // A browser sends a Unicode name in its ASCII form, so the Unicode spelling
    // alone would never match, and the server would refuse its own address.
    it.each([
      ['https://bücher.example', 'xn--bcher-kva.example'],
      ['https://BÜCHER.example', 'xn--bcher-kva.example'],
      ['https://*.bücher.example', 'pr-1.xn--bcher-kva.example'],
      ['https://pr-?.bücher.example', 'pr-1.xn--bcher-kva.example'],
    ])('reads %s in the form a browser sends', (entry, host) => {
      expect(allowing(entry)(host)).toBe(true);
    });

    // A backtracking regular expression took about five seconds to refuse this
    // Host, on every request. The match now takes microseconds, so the bound
    // leaves room for a slow runner without letting the old cost back in.
    it('matches a deep wildcard entry against a long Host in bounded time', () => {
      const rule = allowing(`https://${'*.'.repeat(6)}preview.example`);
      const started = performance.now();

      expect(rule(`${'a.'.repeat(90)}evil.example`)).toBe(false);
      expect(performance.now() - started).toBeLessThan(500);
      expect(rule(`${'a.'.repeat(6)}preview.example`)).toBe(true);
    });
  });

  describe('the public and media URLs', () => {
    const serving = (publicUrl: string) => createHostRule({ ...names, publicUrl, trustedOrigins: [] });

    it.each([
      'https://bge.example#@evil.example',
      'https://bge.example?return=@evil.example',
      'https://bge.example\\@evil.example',
    ])('reads the host in %s as a URL parser does', (publicUrl) => {
      const rule = serving(publicUrl);

      expect(rule('bge.example')).toBe(true);
      expect(rule('evil.example')).toBe(false);
    });

    // These are addresses, not TRUSTED_ORIGINS patterns, so a * in one is
    // just a character and admits nothing else.
    it('takes a * in them literally', () => {
      expect(serving('https://*.example')('evil.example')).toBe(false);
      expect(allowsEveryHost({ ...names, publicUrl: 'https://*' })).toBe(false);
    });

    it('reads the media URL host as well', () => {
      expect(serving('https://bge.example')('media.example')).toBe(true);
    });
  });

  describe('a bare * entry', () => {
    const open: ServerNames = {
      publicUrl: 'https://bge.example',
      trustedOrigins: ['*'],
      mediaBaseUrl: 'https://bge.example/api',
    };

    it('lets every name through, and says so', () => {
      expect(createHostRule(open)('evil.example')).toBe(true);
      expect(allowsEveryHost(open)).toBe(true);
    });

    // Not every name, but an attacker picks the name's depth and shape, so no
    // number of labels makes an entry of nothing but wildcards safe.
    it.each([
      ['https://*.*.*', 'a.evil.example'],
      ['https://*.*.*.*', 'a.b.evil.example'],
      ['https://*.*.*.*.*.*.*.*', 'a.b.c.d.e.f.evil.example'],
      ['https://*.??', 'evil.de'],
    ])('says so for %s, which lets %s through', (entry, host) => {
      const names = { ...open, trustedOrigins: [entry] };

      expect(createHostRule(names)(host)).toBe(true);
      expect(allowsEveryHost(names)).toBe(true);
    });

    it.each(['https://*', 'http://*:5173', '**', 'https://?*', 'https://*.*'])(
      'says so for %s, which lets every name through too',
      (entry) => {
        const names = { ...open, trustedOrigins: [entry] };

        expect(createHostRule(names)('evil.example')).toBe(true);
        expect(allowsEveryHost(names)).toBe(true);
      },
    );

    it.each(['https://*.preview.example', 'myapp://*'])('does not say so for %s', (entry) => {
      const names = { ...open, trustedOrigins: [entry] };

      expect(allowsEveryHost(names)).toBe(false);
      expect(createHostRule(names)('evil.example')).toBe(false);
    });
  });
});
