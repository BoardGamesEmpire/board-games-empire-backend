import type { I18nPath } from '@bge/i18n';
import { APIError } from 'better-auth/api';

export const API_KEY_ROUTES_MOVED = 'API_KEY_ROUTES_MOVED';

const MESSAGE: I18nPath = 'errors.auth.api_key_routes_moved';

/** The prefix every route of better-auth's API key plugin shares. */
const API_KEY_PATH_PREFIX = '/api-key/';

/** The slice of better-auth's endpoint context the block reads. */
export interface ApiKeyRouteBlockContext {
  readonly path?: string;

  /** The HTTP request, present only when the call came in over HTTP; a server-side `auth.api.*` call has none. */
  readonly request?: unknown;
}

export interface ApiKeyRouteBlock {
  /** `hooks.before`, beside the other gates, wrapped in `createAuthMiddleware`. */
  beforeRoute(context: ApiKeyRouteBlockContext): void;
}

/**
 * Refuses an HTTP request to any of better-auth's API key routes
 * (`/api/auth/api-key/*`) with 404 and a BGE code (#1418).
 *
 * A user manages API keys at `/api/api-keys`, where every key scope is checked
 * against what the owner may grant. better-auth's routes would create, edit or
 * delete a key past that check, so they are closed to clients. The whole prefix is refused, not a list of
 * routes, so a route a later plugin version adds is closed too.
 *
 * The server's own calls still go through: `AuthService` creates a key and
 * verifies one through `auth.api.*`, which carries no request.
 *
 * The message is rendered in the fallback locale, as the settings gates' are:
 * `/api/auth/*` runs ahead of Nest's i18n.
 */
export function createApiKeyRouteBlock(render: (key: I18nPath) => string): ApiKeyRouteBlock {
  return {
    beforeRoute(context) {
      if (context.request === undefined || !context.path?.startsWith(API_KEY_PATH_PREFIX)) {
        return;
      }

      throw new APIError('NOT_FOUND', {
        code: API_KEY_ROUTES_MOVED,
        message: render(MESSAGE),
      });
    },
  };
}
