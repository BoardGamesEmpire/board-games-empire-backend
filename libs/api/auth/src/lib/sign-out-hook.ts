import type { I18nPath } from '@bge/i18n';
import { Logger } from '@nestjs/common';
import { APIError } from 'better-auth/api';
import { createHmac, timingSafeEqual } from 'node:crypto';

/** better-auth's sign-out route, by endpoint path. */
const SIGN_OUT_PATH = '/sign-out';

/** The stable code a refused sign-out carries, so a client can announce or rephrase it. */
const SIGN_OUT_FAILED = 'SIGN_OUT_FAILED';

const BEARER_SCHEME = 'bearer ';

export interface SignOutHookDeps {
  /** Renders a refusal's catalog key. */
  readonly render: (key: I18nPath) => string;
}

/** The slice of better-auth's endpoint context the hook reads. */
export interface SignOutHookContext {
  readonly path?: string;
  readonly headers?: Headers;
  getSignedCookie(name: string, secret: string): Promise<string | null | false>;
  readonly context: {
    readonly secret: string;
    readonly authCookies: { readonly sessionToken: { readonly name: string } };
    readonly internalAdapter: { deleteSession(token: string): Promise<void> };
  };
}

export interface SignOutHook {
  /** `hooks.before`, beside the settings gates, wrapped in `createAuthMiddleware`. */
  beforeRoute(context: SignOutHookContext): Promise<void>;
}

/**
 * The session token a bearer credential names, read as the bearer plugin reads
 * it. A signed credential names its token only when the signature is the
 * instance's, and the plugin ignores one that is not. An unsigned credential is
 * the token itself, since `authFactory` runs the plugin without
 * `requireSignature`.
 */
function bearerToken(authorization: string | null | undefined, secret: string): string | null {
  if (!authorization || authorization.slice(0, BEARER_SCHEME.length).toLowerCase() !== BEARER_SCHEME) {
    return null;
  }

  const credential = authorization.slice(BEARER_SCHEME.length).trim();
  if (!credential.includes('.')) {
    return credential || null;
  }

  const decoded = credential.includes('%') ? safeDecode(credential) : credential;
  const [token, signature] = decoded.split('.');

  return token && signature && isSignedBy(secret, token, signature) ? token : null;
}

/**
 * Whether `signature` is the instance's HMAC of `token`. The plugin accepts it
 * in base64 or base64url, padded or not, and Node's base64 decoder reads all
 * four.
 */
function isSignedBy(secret: string, token: string, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(token).digest();
  const given = Buffer.from(signature, 'base64');

  return given.length === expected.length && timingSafeEqual(given, expected);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Fails a sign-out the server could not revoke (#487).
 *
 * better-auth's `/sign-out` deletes the session, logs a failure and answers
 * 200 either way, clearing the cookie. The client then believes it signed
 * out, while the session stays valid for anyone holding a copy of its token.
 * So this deletes the session first, before the route runs. If the delete
 * fails, the sign-out is refused with 503 and the cookie stays, so the client
 * can try again with it. If it succeeds, the route runs as before: its own
 * delete finds nothing left, and it answers 200 and clears the cookie.
 *
 * It deletes every session the request names: the signed cookie's, and a
 * bearer credential's, since the bearer plugin turns one into the cookie only
 * after this hook has run. It reads the credential as the plugin does, so it
 * deletes no session the route would not sign out. Deleting a session nobody
 * signed in with does nothing. Turning the plugin's `requireSignature` on
 * would mean refusing an unsigned credential here too.
 *
 * The message is rendered in the fallback locale, as the settings gates'
 * are: `/api/auth/*` runs ahead of Nest's i18n.
 */
export function createSignOutHook(deps: SignOutHookDeps): SignOutHook {
  const logger = new Logger('SignOut');

  return {
    async beforeRoute(context) {
      if (context.path !== SIGN_OUT_PATH) {
        return;
      }

      const { secret, authCookies, internalAdapter } = context.context;
      const tokens = new Set<string>();

      const cookieToken = await context.getSignedCookie(authCookies.sessionToken.name, secret);
      if (cookieToken) {
        tokens.add(cookieToken);
      }

      const fromBearer = bearerToken(context.headers?.get('authorization'), secret);
      if (fromBearer) {
        tokens.add(fromBearer);
      }

      try {
        for (const token of tokens) {
          await internalAdapter.deleteSession(token);
        }
      } catch (error) {
        logger.error(
          'Could not delete the session, so the sign-out was refused',
          error instanceof Error ? error.stack : error,
        );

        throw new APIError('SERVICE_UNAVAILABLE', {
          code: SIGN_OUT_FAILED,
          message: deps.render('errors.auth.sign_out_failed'),
        });
      }
    },
  };
}
