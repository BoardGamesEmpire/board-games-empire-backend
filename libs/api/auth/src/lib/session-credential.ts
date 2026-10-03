import { AUTH_COOKIE_PREFIX } from './constants';

/**
 * BetterAuth names the session cookie `<prefix>.session_token` (or
 * `<prefix>-session_token`), prepending `__Secure-` when secure cookies are
 * enabled. The prefix is the one `auth-factory` configures, so the live cookie
 * is e.g. `bge_auth_.session_token` / `__Secure-bge_auth_.session_token`.
 */
const SESSION_COOKIE = new RegExp(
  `(?:^|;\\s*)(?:__Secure-)?${AUTH_COOKIE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[.-]session_token=`,
);

/** Whether a `Cookie` header carries BetterAuth's session cookie. */
export function hasSessionCookie(cookie: string | undefined): cookie is string {
  return typeof cookie === 'string' && SESSION_COOKIE.test(cookie);
}

/**
 * Whether an `Authorization` header is a Bearer credential, the one scheme
 * BetterAuth's bearer plugin reads. Any other scheme (a browser's cached
 * Basic credentials for a password-protected host, say) is not a session
 * credential at all.
 */
export function isBearerAuthorization(authorization: string | undefined): authorization is string {
  return typeof authorization === 'string' && /^Bearer\s+/i.test(authorization);
}
