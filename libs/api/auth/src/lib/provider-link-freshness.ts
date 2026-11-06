import type { I18nPath } from '@bge/i18n';
import { APIError, dispatchAuthEndpoint, getSession, type DispatchContext } from 'better-auth/api';

/** The stable code a link refused for a stale session carries, so a client can announce or rephrase it. */
export const PROVIDER_LINK_NEEDS_RECENT_SIGN_IN = 'PROVIDER_LINK_NEEDS_RECENT_SIGN_IN';

const NEEDS_RECENT_SIGN_IN_MESSAGE: I18nPath = 'errors.auth.provider_link_needs_recent_sign_in';

/** better-auth's route that starts linking a sign-in provider to the signed-in user. */
const LINK_SOCIAL_PATH = '/link-social';

/** better-auth's own session read, the one `/link-social`'s session check makes. */
const GET_SESSION = getSession();

export interface ProviderLinkFreshnessDeps {
  /** Renders the refusal's catalog key. */
  readonly render: (key: I18nPath) => string;
  /** The clock, in epoch milliseconds; `Date.now` unless set. */
  readonly now?: () => number;
}

export interface ProviderLinkFreshness {
  /** `hooks.before`, beside the settings gates, wrapped in `createAuthMiddleware`. */
  beforeRoute(context: DispatchContext): Promise<void>;
}

/**
 * Refuses to start linking a sign-in provider from a session signed in
 * `session.freshAge` ago or longer, with 403 and a BGE code (#913).
 *
 * A linked provider is a way to sign in as the user from then on, so starting
 * a link asks for a recent sign-in, as better-auth's fresh-session check does
 * for its other sensitive routes. `/link-social` uses only its plain session
 * check, so the check is made here, by better-auth's rule: a session as old as
 * `freshAge` seconds or older is stale, and a `freshAge` of 0 checks nothing.
 *
 * The session checked must be the one the route will use. Every before hook
 * sees the request as sent: the bearer plugin turns a bearer credential into
 * the session cookie only after all of them have run, writing it over any
 * cookie, and ignores a credential it can't verify. So the session isn't read
 * here from the credentials. It is read by sending the request's headers
 * through better-auth's own pipeline to its session read, which runs the
 * bearer plugin first, as `/link-social` does. A second reading of the
 * credentials could differ from the plugin's on some credential, and that
 * credential would then pass a stale session through.
 *
 * A request naming no session, or one better-auth can't find, is left to the
 * route, which answers 401. A failed read of the session store rejects, so the
 * link isn't started without knowing the session's age.
 *
 * The message is rendered in the fallback locale, as the settings gates' are:
 * `/api/auth/*` runs ahead of Nest's i18n.
 */
export function createProviderLinkFreshness(deps: ProviderLinkFreshnessDeps): ProviderLinkFreshness {
  const now = deps.now ?? Date.now;

  return {
    async beforeRoute(context) {
      if (context.path !== LINK_SOCIAL_PATH || !context.headers) {
        return;
      }

      const { freshAge } = context.context.sessionConfig;
      if (freshAge === 0) {
        return;
      }

      const found = await sessionTheRouteWillUse(context.context, context.headers);
      if (!found) {
        return;
      }

      const signedInAt = new Date(found.session.createdAt).getTime();
      if (now() - signedInAt >= freshAge * 1000) {
        throw new APIError('FORBIDDEN', {
          code: PROVIDER_LINK_NEEDS_RECENT_SIGN_IN,
          message: deps.render(NEEDS_RECENT_SIGN_IN_MESSAGE),
        });
      }
    },
  };
}

/**
 * The session the request's credentials name, as better-auth resolves it for
 * a route: through every before hook, the bearer plugin's included, then its
 * session read. The read leaves the session's expiry alone, which the route's
 * own read refreshes as usual.
 */
async function sessionTheRouteWillUse(
  context: DispatchContext['context'],
  headers: Headers,
): Promise<{ session: { createdAt: Date | string } } | null> {
  const found = await dispatchAuthEndpoint(GET_SESSION, {
    context,
    headers,
    method: 'GET',
    query: { disableRefresh: true },
  });

  return (found as { session: { createdAt: Date | string } } | null) ?? null;
}
