import { appReturnUrl, parseAppReturnAddress } from './return-address';

describe('parseAppReturnAddress', () => {
  // The official app's address, in any letter case, with any path (#1019).
  it.each(['bge://oauth', 'bge://oauth/', 'bge://oauth/server-7', 'BGE://OAUTH/x'])(
    'accepts %p, the official app’s return address (#1019)',
    (address) => {
      expect(parseAppReturnAddress(address)).toBeInstanceOf(URL);
    },
  );

  // A code sent anywhere else could reach someone other than the app that
  // asked for it, so only `bge://oauth` is accepted (#1019).
  it.each([
    'https://attacker.example/cb',
    'http://127.0.0.1:8080/cb',
    'bge://server/abc/x',
    'bge://oauth?x=1',
    'bge://oauth#f',
    'bge://oauth.evil',
    'bge://evil/oauth',
    'bge://user@oauth',
    'bge://oauth:80',
    'bge:oauth',
    'bge:///oauth',
    'javascript:alert(1)',
    '',
    'bge://oauth\n',
  ])('refuses %p (#1019)', (address) => {
    expect(parseAppReturnAddress(address)).toBeNull();
  });

  // URL parsing drops a `?`, `#`, `@` or `:` with nothing after it, and
  // escapes a space, so a check on the parsed address alone would accept each
  // of these (#1019).
  it.each([
    'bge://oauth?',
    'bge://oauth#',
    'bge://oauth/x?',
    'bge://@oauth',
    'bge://:@oauth',
    'bge://oauth:',
    'bge://oauth/a b',
  ])('refuses %p, which URL parsing would normalize into an accepted address (#1019)', (address) => {
    expect(parseAppReturnAddress(address)).toBeNull();
  });

  it('accepts a 512-character address and refuses a 513-character one (#1019)', () => {
    const prefix = 'bge://oauth/';
    const longest = prefix + 'a'.repeat(512 - prefix.length);

    expect(longest).toHaveLength(512);
    expect(parseAppReturnAddress(longest)).toBeInstanceOf(URL);
    expect(parseAppReturnAddress(`${longest}a`)).toBeNull();
  });
});

describe('appReturnUrl', () => {
  // The app's `state` comes back byte for byte, encoded as a query value, so
  // `&`, `=`, `#`, spaces and non-ASCII can't break the address (#1019).
  it('appends each parameter to the return address’s query, after its path (#1019)', () => {
    const address = parseAppReturnAddress('bge://oauth/server-7');

    expect(address).not.toBeNull();
    expect(appReturnUrl(address as URL, { code: 'c', state: 'a&b=c #ü', iss: 'https://bge.example' })).toBe(
      'bge://oauth/server-7?code=c&state=a%26b%3Dc+%23%C3%BC&iss=https%3A%2F%2Fbge.example',
    );
  });

  it('leaves out a parameter that has no value (#1019)', () => {
    const address = parseAppReturnAddress('bge://oauth') as URL;

    expect(appReturnUrl(address, { code: 'c', state: undefined })).toBe('bge://oauth?code=c');
  });

  it('leaves the parsed address it was given unchanged (#1019)', () => {
    const address = parseAppReturnAddress('bge://oauth/x') as URL;

    appReturnUrl(address, { code: 'c' });

    expect(address.href).toBe('bge://oauth/x');
  });
});
