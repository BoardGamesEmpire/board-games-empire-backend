import { createHash, randomBytes } from 'node:crypto';
import { FAKE_PROVIDER_ID } from './e2e-env';
import type { IdTokenFault } from './fake-sign-in-provider';
import { cookiePairs, fakeProviderUrl, registerTicket } from './sign-in-provider';

export const APP_SIGN_IN_START_PATH = '/api/auth/app-sign-in/start';
export const APP_SIGN_IN_RETURN_PATH = '/api/auth/app-sign-in/return';
export const APP_SIGN_IN_TOKEN_PATH = '/api/auth/app-sign-in/token';

/** The official app's return address (#1019). */
export const APP_RETURN_ADDRESS = 'bge://oauth';

/** The user agent the e2e "app" sends, so a test can find it on the session it was given. */
export const APP_USER_AGENT = 'bge-e2e-app/1.0';

/** A fresh PKCE pair, as an app makes one (RFC 7636): a 43-character verifier and its S256 challenge. */
export function pkcePair(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomBytes(32).toString('base64url');

  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export interface AppSignInRequest {
  /** The listed provider to sign in through; the strict fake unless set. */
  readonly providerId?: string;
  /** `redirect_uri`; the official app's address unless set. */
  readonly returnAddress?: string;
  /** The app's `state`; none unless set. */
  readonly state?: string;
  /** `code_challenge_method`; `S256` unless set. */
  readonly method?: string;
  /** Replaces the whole query the options above build, for a malformed request. */
  readonly query?: string;
  /** The browser's own cookies, sent with every step, as a browser already signed in sends them. */
  readonly cookies?: string;
}

/** One redirect the API answered the browser with. */
export interface BrowserStep {
  readonly status: number;
  /** Where it sends the browser. */
  readonly location: URL;
  readonly setCookie: string[];
  readonly headers: Headers;
}

export interface StartedAppSignIn extends BrowserStep {
  /** The verifier of the pair the request's challenge came from. */
  readonly verifier: string;
}

/** A browser's GET, with `cookies` if given, and no redirect followed. */
const browserGet = (url: string | URL, cookies?: string): Promise<Response> =>
  fetch(url, { redirect: 'manual', headers: cookies ? { cookie: cookies } : {} });

/** The redirect a response answers with, or a loud failure, naming `step`, if it isn't one. */
async function stepOf(response: Response, step: string, baseUrl: string): Promise<BrowserStep> {
  const location = response.headers.get('location');
  if (location === null) {
    throw new Error(`${step} did not redirect: ${response.status} ${await response.text()}`);
  }

  return {
    status: response.status,
    location: new URL(location, baseUrl),
    setCookie: response.headers.getSetCookie(),
    headers: response.headers,
  };
}

/** Where a browser's GET of `url`, with `cookies` if given, is sent next. */
export async function nextLocation(baseUrl: string, url: string | URL, cookies?: string): Promise<URL> {
  return (await stepOf(await browserGet(url, cookies), String(url), baseUrl)).location;
}

/**
 * Opens app sign-in's start route, as the app opens it in a browser (#1019),
 * without following its redirect.
 */
export async function startAppSignIn(baseUrl: string, options: AppSignInRequest = {}): Promise<StartedAppSignIn> {
  const pair = pkcePair();
  const query =
    options.query ??
    new URLSearchParams({
      provider: options.providerId ?? FAKE_PROVIDER_ID,
      redirect_uri: options.returnAddress ?? APP_RETURN_ADDRESS,
      code_challenge: pair.challenge,
      code_challenge_method: options.method ?? 'S256',
      ...(options.state === undefined ? {} : { state: options.state }),
    }).toString();

  const response = await browserGet(`${baseUrl}${APP_SIGN_IN_START_PATH}?${query}`, options.cookies);

  return { ...(await stepOf(response, 'app sign-in start', baseUrl)), verifier: pair.verifier };
}

export interface AppSignInThroughProvider {
  /** The `bge://` address the browser ends at. */
  readonly appLocation: URL;
  /** The provider's authorization URL the start route sent the browser to. */
  readonly authorization: URL;
  /** The API's callback response. */
  readonly callback: BrowserStep;
  /** The callback URL the provider sent the browser to, to fetch it again. */
  readonly callbackUrl: URL;
  /** The cookies the browser holds once the start route has answered, its own included. */
  readonly browserCookies: string;
  readonly verifier: string;
  /** The fake's ticket for this sign-in. */
  readonly ticket: string;
}

/**
 * Signs in from a native app through the fake sign-in provider (#1019), as
 * the app's browser would: the start route, the provider, the API's callback,
 * and the return page when the callback sends the browser there, which is the
 * error path. No redirect is followed, so each step is visible.
 */
export async function appSignInThroughProvider(
  baseUrl: string,
  claims: Record<string, unknown>,
  options: AppSignInRequest & { readonly idToken?: IdTokenFault } = {},
): Promise<AppSignInThroughProvider> {
  const start = await startAppSignIn(baseUrl, options);
  if (start.status !== 302 || start.location.origin !== new URL(fakeProviderUrl()).origin) {
    throw new Error(`app sign-in did not reach the provider: ${start.status} ${start.location.href}`);
  }

  const ticket = await registerTicket(fakeProviderUrl(), claims, { idToken: options.idToken });

  const authorize = new URL(start.location);
  authorize.searchParams.set('ticket', ticket);
  const callbackUrl = await nextLocation(baseUrl, authorize);

  const browserCookies = [...cookiePairs(start.setCookie), ...(options.cookies ? [options.cookies] : [])].join('; ');
  const callback = await stepOf(await browserGet(callbackUrl, browserCookies), "the API's callback", baseUrl);

  const appLocation =
    callback.location.pathname === APP_SIGN_IN_RETURN_PATH
      ? await nextLocation(baseUrl, callback.location, browserCookies)
      : callback.location;

  return {
    appLocation,
    authorization: start.location,
    callback,
    callbackUrl,
    browserCookies,
    verifier: start.verifier,
    ticket,
  };
}

/**
 * A POST to app sign-in's token route, as a native app sends one: no cookie
 * and no `Origin`, with `body` sent as it is.
 */
export function postAppSignInToken(baseUrl: string, contentType: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}${APP_SIGN_IN_TOKEN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': contentType, 'user-agent': APP_USER_AGENT },
    body,
  });
}

/** The app's exchange of its code and verifier for a session (#1019), as JSON. */
export function exchangeAppSignInCode(baseUrl: string, body: unknown): Promise<Response> {
  return postAppSignInToken(baseUrl, 'application/json', JSON.stringify(body));
}
