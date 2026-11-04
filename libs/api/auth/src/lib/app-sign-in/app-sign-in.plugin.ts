import type { I18nPath } from '@bge/i18n';
import {
  addOAuthServerContext,
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getOAuthState,
  isAPIError,
  NO_STORE_HEADERS,
} from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { parseUserOutput } from 'better-auth/db';
import { generateIdTokenNonce, generateState, getOAuthCallbackPath } from 'better-auth/oauth2';
import type { BetterAuthPlugin } from 'better-auth/types';
import * as z from 'zod';
import {
  APP_SIGN_IN_CODE_INVALID,
  APP_SIGN_IN_FLOW_INVALID,
  APP_SIGN_IN_MESSAGES,
  APP_SIGN_IN_REQUEST_INVALID,
  APP_SIGN_IN_RETURN_ADDRESS_REFUSED,
  APP_SIGN_IN_UNAVAILABLE,
  type AppSignInErrorCode,
  PROVIDER_NOT_FOUND,
} from './app-sign-in-codes';
import { APP_SIGN_IN_FLOW_KEY, handOffAppSignIn } from './app-sign-in-hand-off';
import { APP_SIGN_IN_PATHS, appSignInReturnPage } from './app-sign-in-paths';
import { createAppSignInStore } from './app-sign-in-store';
import { isJsonObject, type JsonObject, parseJsonObject } from './json-object';
import { isCodeVerifier, isS256Challenge, verifierMatchesChallenge } from './pkce';
import { appReturnUrl, parseAppReturnAddress } from './return-address';

export { APP_SIGN_IN_PATHS } from './app-sign-in-paths';

/** better-auth's provider callback, by endpoint path. */
const CALLBACK_PATH = '/callback/:id';

/** The longest `state` an app may send, in characters. */
const STATE_MAX_LENGTH = 1024;

/** How much of a provider's `error` and `error_description` reaches the app, in characters. */
const ERROR_MAX_LENGTH = 128;
const ERROR_DESCRIPTION_MAX_LENGTH = 1024;

/** The longest code the token route reads, in characters. The server issues 32. */
const CODE_MAX_LENGTH = 64;

/**
 * Every query value as sent. A repeated key arrives as an array, which no
 * check accepts, so a malformed request gets a code rather than a schema
 * error.
 */
const looseQuery = z.record(z.string(), z.unknown());

/** A body a server-side call passes to the token route, whatever it is, for the same reason. */
const looseBody = z.unknown();

/** The one media type the token route reads, as better-auth's own routes read it. */
const JSON_MEDIA_TYPE = 'application/json';

export interface AppSignInOptions {
  /** Renders a key from the message catalog, in the fallback locale. */
  readonly render: (key: I18nPath) => string;
  /** This server's issuer, the `auth.url` discovery publishes, sent to the app as `iss` (RFC 9207). */
  readonly issuer: string;
}

type Query = Readonly<Record<string, unknown>>;

/** What the error page is built from, of better-auth's context. */
interface ErrorPageContext {
  readonly baseURL: string;
  readonly options: { readonly onAPIError?: { readonly errorURL?: string } };
}

/** The query value when it was sent exactly once, or `undefined`: missing, or repeated. */
function singleValue(query: Query, name: string): string | undefined {
  const value = query[name];
  return typeof value === 'string' ? value : undefined;
}

/** The first value sent for `name`, for values better-auth appends and passes through. */
function firstValue(query: Query, name: string): string | undefined {
  const value = query[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : undefined;
}

/** `value` cut to `max` characters, never splitting a character. */
function truncate(value: string, max: number): string {
  const characters = Array.from(value);
  return characters.length <= max ? value : characters.slice(0, max).join('');
}

/**
 * The token request's body when it is a JSON object, or `null`. The route
 * reads its own body: better-auth's parser would answer one it can't read with
 * a code and English text of its own, not this server's (#1019). Only JSON is
 * read, as better-auth's routes read it: a page on another site can send other
 * media types without asking the server first. A call from the server passes
 * its body already parsed, as `parsed`.
 */
async function tokenRequestBody(request: Request | undefined, parsed: unknown): Promise<JsonObject | null> {
  if (request === undefined) {
    return isJsonObject(parsed) ? parsed : null;
  }

  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE) {
    return null;
  }

  return parseJsonObject(await request.text());
}

/** Where a response sends the browser, when it is a redirect: better-auth throws one as a 302 `APIError`. */
function redirectLocation(response: unknown): string | undefined {
  if (!isAPIError(response) || response.statusCode !== 302) {
    return undefined;
  }

  return new Headers(response.headers).get('location') ?? undefined;
}

/**
 * A provider as better-auth's own routes look one up: an entry may be a
 * function that resolves it. better-auth's helper for this isn't exported.
 */
async function findProvider<P extends { readonly id: string }>(
  providers: readonly (P | (() => P | Promise<P>))[],
  id: string,
): Promise<P | undefined> {
  for (const entry of providers) {
    const provider = typeof entry === 'function' ? await entry() : entry;
    if (provider.id === id) {
      return provider;
    }
  }

  return undefined;
}

/**
 * Lets a native app sign in through a sign-in provider and get a session of
 * its own (#1019), with three routes and a hook on the provider's callback:
 *
 * - `start`, opened in a browser, checks the app's request, records it as a
 *   flow, and starts the provider sign-in in that browser, so better-auth's
 *   signed `state` cookie lands there.
 * - The provider's callback finishes it: an after hook hands the session it
 *   created to the app as a single-use code, and sends the browser to
 *   `bge://oauth`. See {@link handOffAppSignIn}.
 * - `return` is the flow's error address: it carries a provider-leg error to
 *   the app.
 * - `token` exchanges the code and the app's PKCE verifier for a session.
 *
 * The only return address is the official app's, `bge://oauth` (#1048 is
 * third-party apps), and every redirect to the app carries `iss`, this
 * server's issuer.
 *
 * The plugin goes first in better-auth's list, so its callback hook runs
 * before every other plugin's: they see a callback that signed no one in, and
 * none of them reacts to the app's sign-in in the browser.
 */
export function appSignIn(options: AppSignInOptions) {
  const message = (code: AppSignInErrorCode): string => options.render(APP_SIGN_IN_MESSAGES[code]);

  /**
   * The server's error page, for a request with no app address to answer:
   * the one better-auth's own callback sends its errors to.
   */
  const errorPage = (context: ErrorPageContext, code: AppSignInErrorCode): string => {
    const url = new URL(context.options.onAPIError?.errorURL || `${context.baseURL}/error`, context.baseURL);
    url.searchParams.set('error', code);
    url.searchParams.set('error_description', message(code));
    return url.href;
  };

  /** `address` with the answer's parameters and this server's issuer. */
  const toApp = (address: URL, params: Readonly<Record<string, string | undefined>>): string =>
    appReturnUrl(address, { ...params, iss: options.issuer });

  return {
    id: 'app-sign-in',

    endpoints: {
      appSignInStart: createAuthEndpoint(
        APP_SIGN_IN_PATHS.start,
        { method: 'GET', query: looseQuery, metadata: { noStore: true } },
        async (ctx) => {
          const query = ctx.query;

          // Without an address this server sends sign-ins to, nothing can go
          // back to the app, so the browser stays here.
          const returnAddress = singleValue(query, 'redirect_uri');
          const address = returnAddress === undefined ? null : parseAppReturnAddress(returnAddress);
          if (returnAddress === undefined || address === null) {
            throw ctx.redirect(errorPage(ctx.context, APP_SIGN_IN_RETURN_ADDRESS_REFUSED));
          }

          const rawState = query['state'];
          const state = typeof rawState === 'string' && rawState.length <= STATE_MAX_LENGTH ? rawState : undefined;
          const codeChallenge = singleValue(query, 'code_challenge');

          if (
            singleValue(query, 'code_challenge_method') !== 'S256' ||
            codeChallenge === undefined ||
            !isS256Challenge(codeChallenge) ||
            (rawState !== undefined && state === undefined)
          ) {
            throw ctx.redirect(
              toApp(address, {
                error: APP_SIGN_IN_REQUEST_INVALID,
                error_description: message(APP_SIGN_IN_REQUEST_INVALID),
                state,
              }),
            );
          }

          // genericOAuth's before hook has already retried the discovery of a
          // provider named in `provider` whose discovery failed at boot.
          const providerId = singleValue(query, 'provider');
          const provider =
            providerId === undefined ? undefined : await findProvider(ctx.context.socialProviders, providerId);
          if (provider === undefined) {
            throw ctx.redirect(
              toApp(address, { error: PROVIDER_NOT_FOUND, error_description: message(PROVIDER_NOT_FOUND), state }),
            );
          }

          const store = createAppSignInStore(ctx.context.internalAdapter);
          let flowId: string | undefined;
          let authorization: URL;

          // Storing the flow or the state, or building the provider's address,
          // can fail: the app is told, as it is of every other refusal, rather
          // than the browser getting better-auth's raw error.
          try {
            flowId = await store.openFlow({
              returnAddress: address,
              codeChallenge,
              ...(state === undefined ? {} : { state }),
            });
            await addOAuthServerContext({ [APP_SIGN_IN_FLOW_KEY]: flowId });

            // As better-auth's social sign-in starts its redirect flow, with
            // the return page as every address the callback may send the
            // browser to. The callback hook hands a sign-in over before it would.
            const returnPage = appSignInReturnPage(flowId);
            const idTokenNonce = generateIdTokenNonce(provider);
            const { state: providerState, codeVerifier } = await generateState(
              {
                ...ctx,
                body: { callbackURL: returnPage, errorCallbackURL: returnPage, newUserCallbackURL: returnPage },
              },
              { idTokenNonce },
            );
            authorization = await provider.createAuthorizationURL({
              state: providerState,
              codeVerifier,
              idTokenNonce,
              redirectURI: `${ctx.context.baseURL}${getOAuthCallbackPath(provider)}`,
            });
          } catch (error) {
            ctx.context.logger.error('Could not start an app sign-in', error);
            if (flowId !== undefined) {
              await store.takeFlow(flowId).catch((cleanup: unknown) => {
                ctx.context.logger.error('Could not remove the flow of an app sign-in that failed to start', cleanup);
              });
            }

            throw ctx.redirect(
              toApp(address, {
                error: APP_SIGN_IN_UNAVAILABLE,
                error_description: message(APP_SIGN_IN_UNAVAILABLE),
                state,
              }),
            );
          }

          throw ctx.redirect(authorization.toString());
        },
      ),

      appSignInReturn: createAuthEndpoint(
        APP_SIGN_IN_PATHS.return,
        { method: 'GET', query: looseQuery, metadata: { noStore: true } },
        async (ctx) => {
          const query = ctx.query;
          const flowId = singleValue(query, 'flow');
          const flow =
            flowId === undefined ? null : await createAppSignInStore(ctx.context.internalAdapter).takeFlow(flowId);

          if (flow === null) {
            throw ctx.redirect(errorPage(ctx.context, APP_SIGN_IN_FLOW_INVALID));
          }

          // An error from the provider leg, as the callback appended it.
          const error = firstValue(query, 'error');
          if (error) {
            const description = firstValue(query, 'error_description');

            throw ctx.redirect(
              toApp(flow.returnAddress, {
                error: truncate(error, ERROR_MAX_LENGTH),
                error_description:
                  description === undefined ? undefined : truncate(description, ERROR_DESCRIPTION_MAX_LENGTH),
                state: flow.state,
              }),
            );
          }

          // A sign-in reached this page without the callback handing it over,
          // such as a web sign-in someone pointed here. The flow is used up,
          // and the app never gets a code from this page.
          throw ctx.redirect(
            toApp(flow.returnAddress, {
              error: APP_SIGN_IN_FLOW_INVALID,
              error_description: message(APP_SIGN_IN_FLOW_INVALID),
              state: flow.state,
            }),
          );
        },
      ),

      appSignInToken: createAuthEndpoint(
        APP_SIGN_IN_PATHS.token,
        { method: 'POST', body: looseBody, disableBody: true, metadata: { noStore: true } },
        async (ctx) => {
          const body = (await tokenRequestBody(ctx.request, ctx.body)) ?? {};
          const code = body['code'];
          const verifier = body['code_verifier'];

          // A request that can't be read never reaches the store, so its code
          // stays usable for a proper one.
          if (
            typeof code !== 'string' ||
            code.length > CODE_MAX_LENGTH ||
            typeof verifier !== 'string' ||
            !isCodeVerifier(verifier)
          ) {
            throw new APIError('BAD_REQUEST', {
              code: APP_SIGN_IN_REQUEST_INVALID,
              message: message(APP_SIGN_IN_REQUEST_INVALID),
            });
          }

          // Redeeming uses the code up, whether or not the verifier matches:
          // a weak verifier gets one guess per code. Someone holding a code
          // without its verifier can spend it first, but a custom-scheme
          // redirect reaches one app, so a code someone else holds is one the
          // app never got.
          const issued = await createAppSignInStore(ctx.context.internalAdapter).redeemCode(code);
          const user =
            issued !== null && verifierMatchesChallenge(verifier, issued.codeChallenge)
              ? await ctx.context.internalAdapter.findUserById(issued.userId)
              : null;

          if (user === null) {
            throw new APIError('BAD_REQUEST', {
              code: APP_SIGN_IN_CODE_INVALID,
              message: message(APP_SIGN_IN_CODE_INVALID),
            });
          }

          // A fresh session, recording this request's user agent and address.
          // The admin plugin refuses one for a user banned since the code was
          // issued, with its own 403.
          const session = await ctx.context.internalAdapter.createSession(user.id);
          // The bearer plugin hands the token over as `set-auth-token` too.
          await setSessionCookie(ctx, { session, user });

          return ctx.json({ token: session.token, user: parseUserOutput(ctx.context.options, user) });
        },
      ),
    },

    hooks: {
      after: [
        {
          matcher: (context) => context.path === CALLBACK_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const cookies = ctx.context.authCookies;

            const target = await handOffAppSignIn({
              oauthState: await getOAuthState(),
              created: ctx.context.newSession,
              callbackLocation: redirectLocation(ctx.context.returned),
              // The headers the callback left. A hook's own headers, and a
              // redirect it throws, are merged into these afterwards.
              responseHeaders: ctx.context.responseHeaders,
              forgetNewSession: () => ctx.context.setNewSession(null),
              credentialCookies: [
                cookies.sessionToken.name,
                cookies.sessionData.name,
                cookies.dontRememberToken.name,
                cookies.accountData.name,
              ],
              store: createAppSignInStore(ctx.context.internalAdapter),
              deleteSession: (token) => ctx.context.internalAdapter.deleteSession(token),
              logger: ctx.context.logger,
              issuer: options.issuer,
              errorPage: (code) => errorPage(ctx.context, code),
              message,
            });

            if (target === undefined) {
              return;
            }

            for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
              ctx.setHeader(name, value);
            }

            throw ctx.redirect(target);
          }),
        },
      ],
    },

    // better-auth's own limit for its sign-in routes, which starts with
    // `/sign-in` and so misses these. The return page keeps the default.
    rateLimit: [
      { pathMatcher: (path: string) => path === APP_SIGN_IN_PATHS.start, window: 10, max: 3 },
      { pathMatcher: (path: string) => path === APP_SIGN_IN_PATHS.token, window: 10, max: 3 },
    ],
  } satisfies BetterAuthPlugin;
}
