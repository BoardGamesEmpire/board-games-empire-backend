import { isAPIError } from 'better-auth/api';
import { API_KEY_ROUTES_MOVED, createApiKeyRouteBlock } from './api-key-route-block';

/** What a refusal carries on the wire, read off the thrown `APIError`. */
function refusalOf(attempt: () => void): { code?: string; message?: string; status: number } | undefined {
  try {
    attempt();
  } catch (error) {
    if (!isAPIError(error)) {
      throw error;
    }

    const body = error.body as { code?: string; message?: string } | undefined;
    return { status: error.statusCode, code: body?.code, message: body?.message };
  }

  return undefined;
}

/** Stands in for the `Request` better-auth hands a hook on an HTTP call. */
const HTTP_REQUEST = new Request('http://localhost:3000/api/auth/api-key/create', { method: 'POST' });

describe('createApiKeyRouteBlock', () => {
  const block = createApiKeyRouteBlock((key) => `rendered:${key}`);

  // A user manages API keys at /api/api-keys, where key scopes are checked
  // against what the owner may grant; better-auth's own routes would skip that
  // check (#1418).
  it('refuses an HTTP request to /api-key/create with 404 API_KEY_ROUTES_MOVED (#1418)', () => {
    expect(refusalOf(() => block.beforeRoute({ path: '/api-key/create', request: HTTP_REQUEST }))).toEqual({
      status: 404,
      code: API_KEY_ROUTES_MOVED,
      message: 'rendered:errors.auth.api_key_routes_moved',
    });
  });

  it('refuses an HTTP request to /api-key/list with 404 API_KEY_ROUTES_MOVED (#1418)', () => {
    expect(refusalOf(() => block.beforeRoute({ path: '/api-key/list', request: HTTP_REQUEST }))).toEqual({
      status: 404,
      code: API_KEY_ROUTES_MOVED,
      message: 'rendered:errors.auth.api_key_routes_moved',
    });
  });

  // A later plugin version may add a route; the block covers the whole prefix,
  // not a list that would fall behind (#1418).
  it('refuses an HTTP request to /api-key/future-route with 404 API_KEY_ROUTES_MOVED (#1418)', () => {
    expect(refusalOf(() => block.beforeRoute({ path: '/api-key/future-route', request: HTTP_REQUEST }))).toEqual({
      status: 404,
      code: API_KEY_ROUTES_MOVED,
      message: 'rendered:errors.auth.api_key_routes_moved',
    });
  });

  // The server's own calls, such as creating a key for /api/api-keys, go
  // through `auth.api.*` with no request (#1418).
  it('lets a server-side call through: no request (#1418)', () => {
    expect(refusalOf(() => block.beforeRoute({ path: '/api-key/create', request: undefined }))).toBeUndefined();
    expect(refusalOf(() => block.beforeRoute({ path: '/api-key/get' }))).toBeUndefined();
  });

  it('ignores other paths (#1418)', () => {
    expect(refusalOf(() => block.beforeRoute({ path: '/sign-in/email', request: HTTP_REQUEST }))).toBeUndefined();
    expect(refusalOf(() => block.beforeRoute({ path: '/api-key', request: HTTP_REQUEST }))).toBeUndefined();
    expect(refusalOf(() => block.beforeRoute({ request: HTTP_REQUEST }))).toBeUndefined();
  });
});
