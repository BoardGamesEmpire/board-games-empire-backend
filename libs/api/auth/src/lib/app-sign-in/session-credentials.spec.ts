import { withoutSessionCredentials } from './session-credentials';

const CREDENTIAL_COOKIES = ['bge.session_token', 'bge.session_data', 'bge.dont_remember', 'bge.account_data'] as const;

/** A response's headers with every cookie in `setCookies` set, and any other header given. */
function responseHeaders(setCookies: readonly string[], other: Record<string, string> = {}): Headers {
  const headers = new Headers(other);
  for (const cookie of setCookies) {
    headers.append('set-cookie', cookie);
  }

  return headers;
}

describe('withoutSessionCredentials', () => {
  // The callback's session is handed to the app, never to the browser, so a
  // tab left open holds nothing (#1019). The spent state cookie's expiry and
  // every unrelated header stay.
  it('removes the session cookies, their chunks and the bearer token, and keeps the rest (#1019)', () => {
    const headers = responseHeaders(
      [
        'bge.session_token=token.signature; Path=/; HttpOnly; SameSite=Lax',
        'bge.session_data.0=chunk-one; Path=/',
        'bge.session_data.1=chunk-two; Path=/',
        'bge.dont_remember=true.signature; Path=/',
        'bge.state=; Max-Age=0; Path=/',
      ],
      {
        'set-auth-token': 'token.signature',
        'Access-Control-Expose-Headers': 'set-auth-token, x-other',
        location: '/api/auth/app-sign-in/return?flow=f',
      },
    );

    withoutSessionCredentials(headers, CREDENTIAL_COOKIES);

    expect(headers.getSetCookie()).toEqual(['bge.state=; Max-Age=0; Path=/']);
    expect(headers.get('set-auth-token')).toBeNull();
    expect(headers.get('access-control-expose-headers')).toBe('x-other');
    expect(headers.get('location')).toBe('/api/auth/app-sign-in/return?flow=f');
  });

  it('drops the expose header when the bearer token was all it listed (#1019)', () => {
    const headers = responseHeaders(['bge.session_token=t; Path=/'], {
      'set-auth-token': 't',
      'Access-Control-Expose-Headers': 'set-auth-token',
    });

    withoutSessionCredentials(headers, CREDENTIAL_COOKIES);

    expect(headers.has('access-control-expose-headers')).toBe(false);
  });

  // Only a credential's own name, or one of its numbered chunks, is removed.
  it('keeps cookies whose names only begin like a credential’s (#1019)', () => {
    const lookalikes = ['bge.session_token_hint=1; Path=/', 'bge.session_data.extra=1; Path=/', 'other=1'];
    const headers = responseHeaders(lookalikes);

    withoutSessionCredentials(headers, CREDENTIAL_COOKIES);

    expect(headers.getSetCookie()).toEqual(lookalikes);
  });

  it('leaves a response without a session credential unchanged (#1019)', () => {
    const headers = responseHeaders(['bge.state=; Max-Age=0; Path=/', 'theme=dark'], {
      'Access-Control-Expose-Headers': 'x-other',
      location: '/somewhere',
    });
    const before = [...headers.entries()];

    withoutSessionCredentials(headers, CREDENTIAL_COOKIES);

    expect([...headers.entries()]).toEqual(before);
  });
});
