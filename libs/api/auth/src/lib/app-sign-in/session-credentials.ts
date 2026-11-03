/** The header the bearer plugin hands a client its session token in. */
const SET_AUTH_TOKEN = 'set-auth-token';

const EXPOSE_HEADERS = 'access-control-expose-headers';

/** A numbered chunk of a cookie too large for one, as better-auth names it: `<name>.<n>`. */
const CHUNK_SUFFIX = /^\.\d+$/;

function cookieName(setCookie: string): string {
  const separator = setCookie.indexOf('=');
  return (separator === -1 ? setCookie : setCookie.slice(0, separator)).trim();
}

/**
 * Removes every session credential from a response's headers, in place
 * (#1019): each `Set-Cookie` named one of `cookieNames`, or a chunk of one,
 * and the bearer plugin's `set-auth-token`, which also leaves
 * `Access-Control-Expose-Headers`. Every other cookie and header stays.
 *
 * Nothing is sent in a credential's place, not even an expiry, so a browser
 * that was already signed in keeps its own session.
 */
export function withoutSessionCredentials(headers: Headers, cookieNames: readonly string[]): void {
  const isCredential = (name: string): boolean =>
    cookieNames.some(
      (credential) =>
        name === credential || (name.startsWith(credential) && CHUNK_SUFFIX.test(name.slice(credential.length))),
    );

  const cookies = headers.getSetCookie();
  const kept = cookies.filter((cookie) => !isCredential(cookieName(cookie)));
  if (kept.length !== cookies.length) {
    headers.delete('set-cookie');
    for (const cookie of kept) {
      headers.append('set-cookie', cookie);
    }
  }

  headers.delete(SET_AUTH_TOKEN);

  const exposed = headers.get(EXPOSE_HEADERS);
  if (exposed === null) {
    return;
  }

  const listed = exposed
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const stillExposed = listed.filter((name) => name.toLowerCase() !== SET_AUTH_TOKEN);

  if (stillExposed.length === listed.length) {
    return;
  }

  if (stillExposed.length === 0) {
    headers.delete(EXPOSE_HEADERS);
  } else {
    headers.set(EXPOSE_HEADERS, stillExposed.join(', '));
  }
}
