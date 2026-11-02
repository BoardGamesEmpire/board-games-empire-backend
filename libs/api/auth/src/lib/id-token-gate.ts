import type { I18nPath } from '@bge/i18n';
import { APIError } from 'better-auth/api';

export const SIGN_IN_PROVIDER_ID_TOKEN_REFUSED = 'SIGN_IN_PROVIDER_ID_TOKEN_REFUSED';

const MESSAGE: I18nPath = 'errors.auth.sign_in_provider_id_token_refused';

/**
 * The better-auth routes that take a sign-in provider's ID token in place of
 * the redirect flow: a sign-in and a link.
 */
const ID_TOKEN_PATHS: ReadonlySet<string> = new Set(['/sign-in/social', '/link-social']);

/** The slice of better-auth's endpoint context the gate reads. */
export interface IdTokenGateContext {
  readonly path?: string;
  /** The request body as sent, before the route validates it. */
  readonly body?: { readonly idToken?: unknown; readonly [field: string]: unknown } | null;
}

export interface IdTokenGate {
  /** `hooks.before`, beside the settings gates, wrapped in `createAuthMiddleware`. */
  beforeRoute(context: IdTokenGateContext): void;
}

/**
 * Refuses a client that submits a sign-in provider's ID token to sign in or to
 * link, with 403 and a BGE code (#1016).
 *
 * The redirect flow carries state and PKCE, and its ID token comes from the
 * provider's own token endpoint. A submitted token has neither, so it is a
 * second way in that nothing here uses. better-auth's core has an option to
 * switch it off, but `genericOAuth` does not take it, so the route is refused
 * here. Native sign-in (#1019) can reopen it once it has a design.
 *
 * Any `idToken` is a submission, whatever its value: the route would reject a
 * malformed one itself, but the refusal does not depend on that. Google One
 * Tap's body is an ID token by design, and it is not a sign-in provider's
 * route, so it is left alone. It signs nobody in here: `oneTap()` is given no
 * Google client id, so its route answers every call with 400.
 *
 * The message is rendered in the fallback locale, as the settings gates' are:
 * `/api/auth/*` runs ahead of Nest's i18n.
 */
export function createIdTokenGate(render: (key: I18nPath) => string): IdTokenGate {
  return {
    beforeRoute(context) {
      if (context.path === undefined || !ID_TOKEN_PATHS.has(context.path) || context.body?.idToken === undefined) {
        return;
      }

      throw new APIError('FORBIDDEN', {
        code: SIGN_IN_PROVIDER_ID_TOKEN_REFUSED,
        message: render(MESSAGE),
      });
    },
  };
}
