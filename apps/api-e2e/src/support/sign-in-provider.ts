import { postToAuth } from './auth-routes';
import { E2E_FAKE_PROVIDER_URL_VAR, FAKE_PROVIDER_ID } from './e2e-env';

const SIGN_IN_PATH = '/api/auth/sign-in/oauth2';
const LINK_PATH = '/api/auth/oauth2/link';

/** better-auth's session cookie is `<prefix>.session_token`; the prefix is the auth lib's. */
const SESSION_COOKIE_SUFFIX = '.session_token';

/** Where the fake sign-in provider listens, or a loud failure if `global-setup` never started it. */
export function fakeProviderUrl(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const url = env[E2E_FAKE_PROVIDER_URL_VAR]?.trim();

  if (!url) {
    throw new Error(
      `${E2E_FAKE_PROVIDER_URL_VAR} is not set — did the e2e globalSetup start the fake sign-in provider?`,
    );
  }

  return url;
}

export interface ProviderSignInResult {
  /**
   * Where the API sent the browser at the end: the `callbackURL` the flow was
   * started with, or better-auth's error page with an `error` code.
   */
  readonly location: URL;

  /** The session cookie the callback set, as `name=value`, or `''` when it set none. */
  readonly cookie: string;

  /** The fake's ticket for this sign-in, to read back what the API asked the provider for. */
  readonly ticket: string;
}

export interface ProviderSignInOptions {
  /**
   * A signed-in user's headers. With them the flow links the provider to that
   * user (`/oauth2/link`) instead of signing in with it.
   */
  readonly linkWith?: Record<string, string>;
}

/** Each `Set-Cookie` header as the `name=value` pair a `Cookie` header sends back. */
function cookiePairs(setCookie: readonly string[] | string | undefined): string[] {
  const headers = typeof setCookie === 'string' ? [setCookie] : (setCookie ?? []);

  return headers.map((header) => header.split(';')[0].trim()).filter((pair) => pair.length > 0);
}

async function registerTicket(providerUrl: string, claims: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${providerUrl}/tickets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(claims),
  });
  const body: unknown = await response.json();

  if (response.status !== 201 || typeof (body as { ticket?: unknown }).ticket !== 'string') {
    throw new Error(`the fake sign-in provider refused the claims: ${response.status} ${JSON.stringify(body)}`);
  }

  return (body as { ticket: string }).ticket;
}

/**
 * Signs in through the fake sign-in provider (#912), as a browser would, with
 * `claims` as what the provider says about the user: the API starts the flow,
 * the browser goes to the provider and comes back to the API's callback, and
 * the callback redirects. No redirect is followed, so each step is visible.
 *
 * The callback is called with the cookies the start of the flow set, because
 * better-auth checks the flow's state against one of them.
 */
export async function signInThroughProvider(
  baseUrl: string,
  claims: Record<string, unknown>,
  options: ProviderSignInOptions = {},
): Promise<ProviderSignInResult> {
  const body = { providerId: FAKE_PROVIDER_ID, callbackURL: '/' };

  const start = options.linkWith
    ? await postToAuth(baseUrl, LINK_PATH).set(options.linkWith).send(body)
    : await postToAuth(baseUrl, SIGN_IN_PATH).send(body);

  if (start.status !== 200 || typeof start.body?.url !== 'string') {
    throw new Error(`starting a provider sign-in failed: ${start.status} ${JSON.stringify(start.body)}`);
  }

  const ticket = await registerTicket(fakeProviderUrl(), claims);

  const authorize = new URL(start.body.url);
  authorize.searchParams.set('ticket', ticket);
  const consent = await fetch(authorize, { redirect: 'manual' });
  const callback = consent.headers.get('location');

  if (consent.status !== 302 || callback === null) {
    throw new Error(`the fake sign-in provider did not redirect back: ${consent.status} ${await consent.text()}`);
  }

  const finish = await fetch(callback, {
    redirect: 'manual',
    headers: { cookie: cookiePairs(start.headers['set-cookie']).join('; ') },
  });
  const location = finish.headers.get('location');

  if (location === null) {
    throw new Error(`the API's callback did not redirect: ${finish.status} ${await finish.text()}`);
  }

  // A cookie set to nothing is one being cleared, not a session.
  const session = cookiePairs(finish.headers.getSetCookie()).find((pair) => {
    const [name, value] = pair.split('=', 2);
    return name.endsWith(SESSION_COOKIE_SUFFIX) && Boolean(value);
  });

  return { location: new URL(location, baseUrl), cookie: session ?? '', ticket };
}
