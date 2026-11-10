export const AUTH_INSTANCE = Symbol('AUTH_INSTANCE');

/**
 * better-auth's handler as the api serves it on `/api/auth/*`: its rate
 * limiter's 429 (#640), a storage failure (503 `AUTH_UNAVAILABLE`) and any
 * other failure that would answer an empty 500 (500 `AUTH_FAILED`, #894) get
 * a stable code and a plain-language message (`createAuthRequestHandler`).
 */
export const AUTH_REQUEST_HANDLER = Symbol('AUTH_REQUEST_HANDLER');

/**
 * Hard app-wide request body cap (256 KB), enforced by the better-auth JSON /
 * URL-encoded parsers. better-auth requires Nest's built-in body parser to be
 * disabled (`bodyParser: false` in `main.ts`) and re-adds its own for every
 * non-auth route, so this is the single place the limit can be set. Also lifts
 * express's 100 KB default, which sits below the feedback field caps (#45).
 */
export const MAX_REQUEST_BODY_BYTES = 256 * 1024;

export enum AuthEvent {
  UserCreated = 'auth.user.created',
}

/**
 * The base path for all BetterAuth endpoints
 */
export const AUTH_BASE_PATH = '/api/auth';

/**
 * The prefix BetterAuth names its cookies with (`advanced.cookiePrefix`), so
 * the session cookie is `bge_auth_.session_token`. `hasSessionCookie` builds
 * its match from the same value.
 */
export const AUTH_COOKIE_PREFIX = 'bge_auth_';

/**
 * The request header better-auth reads a client's IP from
 * (`advanced.ipAddress.ipAddressHeaders`). The api owns it: a handler ahead of
 * better-auth's routes writes the address there, by the Nest throttler's rule,
 * over any value the client sent (#640). better-auth keys its rate limits and
 * a session's recorded address on it.
 */
export const AUTH_CLIENT_IP_HEADER = 'x-bge-client-ip';

/**
 * The longest display name a profile holds, in characters. Provisioning cuts
 * a starting name to it and the profile edit refuses a longer one, so a client
 * can always send back the name it was served (#819).
 */
export const DISPLAY_NAME_MAX_LENGTH = 64;

/**
 * How recently a session must have signed in, in seconds, for better-auth's
 * fresh-session checks and for starting a link to a sign-in provider: one day
 * (`session.freshAge`, #913).
 */
export const SESSION_FRESH_AGE_SECONDS = 86_400;
