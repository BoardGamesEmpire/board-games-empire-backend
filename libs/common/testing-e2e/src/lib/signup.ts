import { randomUUID } from 'node:crypto';

/**
 * The mounted BetterAuth email signup route: `AUTH_BASE_PATH` ('/api/auth')
 * plus the emailAndPassword handler. Inlined rather than imported from
 * `@bge/auth` deliberately — this lib must not pull the auth lib (and its
 * better-auth dependency graph) into the test process; the black-box
 * harness talks to the route, not the module (#255 revised D-6).
 */
export const SIGN_UP_EMAIL_PATH = '/api/auth/sign-up/email';

/**
 * The bearer() plugin returns the session token in this response header on
 * sign-up/sign-in. Preferred over the response body's `token` field because
 * the header is the plugin's documented transport for what a subsequent
 * `Authorization: Bearer` must carry.
 */
export const SET_AUTH_TOKEN_HEADER = 'set-auth-token';

export interface SignupOptions {
  readonly username?: string;
  readonly email?: string;
  readonly password?: string;
  readonly firstName?: string;
  readonly lastName?: string;
}

/**
 * The wire payload for {@link SIGN_UP_EMAIL_PATH}. `name` is BetterAuth's
 * field; `authFactory` maps it onto the `username` column (`user.fields`),
 * and `firstName`/`lastName` are the configured `additionalFields`.
 */
export interface SignupRequestBody {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly firstName?: string;
  readonly lastName?: string;
}

export interface PreparedSignup {
  readonly body: SignupRequestBody;
  readonly username: string;
  readonly email: string;
  readonly password: string;
}

/**
 * Generates a unique, valid signup payload. Uniqueness is random, never
 * sequential — deterministic identifiers are exactly what lets a stale
 * ability-cache entry from a truncated user be re-derived by a later test
 * (#268), so nothing here may be predictable across runs.
 */
export function prepareSignup(options: SignupOptions = {}): PreparedSignup {
  const unique = randomUUID().replaceAll('-', '').slice(0, 12);

  const username = options.username ?? `e2e-user-${unique}`;
  const email = options.email ?? `e2e-${unique}@e2e.invalid`;
  const password = options.password ?? `E2e!${unique}Aa1`;

  const body: SignupRequestBody = {
    name: username,
    email,
    password,
    ...(options.firstName !== undefined ? { firstName: options.firstName } : {}),
    ...(options.lastName !== undefined ? { lastName: options.lastName } : {}),
  };

  return { body, username, email, password };
}

interface TokenBearingBody {
  readonly token?: string | null;
}

interface UserBearingBody {
  readonly user?: { readonly id?: string } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readBodyToken(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }

  const token = (body as TokenBearingBody).token;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/**
 * Resolves the session token from a signup/sign-in response: the
 * `set-auth-token` header when present (the bearer plugin's transport),
 * falling back to the body's `token` field. Failing to find either is a
 * configuration regression worth naming, not a bare undefined.
 */
export function extractSessionToken(headers: Headers, body: unknown): string {
  const headerToken = headers.get(SET_AUTH_TOKEN_HEADER);
  if (headerToken !== null && headerToken.length > 0) {
    return headerToken;
  }

  const bodyToken = readBodyToken(body);
  if (bodyToken !== undefined) {
    return bodyToken;
  }

  throw new Error(
    `Signup succeeded but no session token was found: neither a '${SET_AUTH_TOKEN_HEADER}' response header ` +
      `nor a 'token' field in the response body. Is the bearer() plugin still enabled in authFactory?`,
  );
}

/** Resolves the created user's id from the signup response body, loudly. */
export function extractUserId(body: unknown): string {
  if (isRecord(body)) {
    const user = (body as UserBearingBody).user;
    // isRecord (not a bare undefined check) so a `{ user: null }` body gets
    // the loud shape-changed error below instead of a TypeError on `.id`.
    if (isRecord(user) && typeof user.id === 'string' && user.id.length > 0) {
      return user.id;
    }
  }

  throw new Error(
    `Signup succeeded but the response body carried no 'user.id' — the BetterAuth response shape has changed; ` +
      `update @bge/testing-e2e's signup parsing to match.`,
  );
}

/**
 * A non-2xx signup translated into an actionable message. The 404 case is
 * called out specifically because it is a known configuration mode, not a
 * bug: the route disappears entirely when email/password auth is disabled
 * (#256 — factories must name the config rather than surface a bare 404).
 */
export function signupFailureMessage(status: number, bodyText: string): string {
  if (status === 404) {
    return (
      `POST ${SIGN_UP_EMAIL_PATH} returned 404 — email/password auth appears to be disabled in the ` +
      `environment the API was launched with. Set USE_EMAIL_PASSWORD_AUTH=true (CI copies .env.example, ` +
      `which enables it; a local .env may not).`
    );
  }

  return `POST ${SIGN_UP_EMAIL_PATH} failed with status ${status}: ${bodyText}`;
}

export interface SignupResult {
  readonly userId: string;
  readonly token: string;
  readonly username: string;
  readonly email: string;
  readonly password: string;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}

/**
 * Signs a user up through the REAL wire path — the mounted BetterAuth
 * handler on the running server. This is the only signup path the factories
 * use (#256 revised decision 2): a test-process `authFactory(...).api`
 * call would run the `user.create.after` hook HERE, emitting the
 * provisioning event into an EventEmitter2 with no registered listeners —
 * the user would exist with no preferences, profile, or role, and every
 * authorization assertion downstream would fail for the wrong reason.
 *
 * Note: the caller must still wait for provisioning (see
 * `waitForProvisionedRoleName` in actors.ts) — a 2xx here proves the row
 * exists, not that the asynchronous provisioning listener has run.
 *
 * Sends an explicit `Origin`. BetterAuth's origin check rejects a
 * state-changing request that carries neither `Origin` nor `Referer` with
 * `MISSING_OR_NULL_ORIGIN`, and `fetch` on the server sends no `Origin` of
 * its own — only browsers do. Setting it to the base URL makes the request
 * look like what a real client sends and keeps the check ARMED; the
 * alternative, `DISABLE_ORIGIN_CHECK=true` for the suite, would switch off a
 * security control in the tests meant to prove it works.
 */
export async function performSignup(
  baseUrl: string,
  options: SignupOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<SignupResult> {
  const prepared = prepareSignup(options);

  const origin = trimTrailingSlash(baseUrl);

  const response = await fetchFn(`${origin}${SIGN_UP_EMAIL_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(prepared.body),
  });

  if (!response.ok) {
    throw new Error(signupFailureMessage(response.status, await safeText(response)));
  }

  const parsed: unknown = await response.json();

  return {
    userId: extractUserId(parsed),
    token: extractSessionToken(response.headers, parsed),
    username: prepared.username,
    email: prepared.email,
    password: prepared.password,
  };
}
