import { APP_SIGN_IN_FLOW_INVALID, APP_SIGN_IN_UNAVAILABLE, type AppSignInErrorCode } from './app-sign-in-codes';
import { appSignInReturnPage } from './app-sign-in-paths';
import type { AppSignInStore } from './app-sign-in-store';
import { appReturnUrl } from './return-address';
import { withoutSessionCredentials } from './session-credentials';

/**
 * The key an app sign-in's flow id rides under in better-auth's OAuth server
 * context (#1019). better-auth writes the server context into the state after
 * the client's `additionalData`, so a client can't set it.
 */
export const APP_SIGN_IN_FLOW_KEY = 'appSignInFlow';

/** What the hand-off reads of the callback request, and what it acts through. */
export interface AppSignInHandOff {
  /**
   * better-auth's parsed OAuth state on the callback (`getOAuthState()`), or
   * `null`. Only `serverContext` is read: the other fields, `callbackURL`
   * among them, are the client's to choose.
   */
  readonly oauthState: {
    readonly serverContext?: Readonly<Record<string, unknown>>;
    readonly [field: string]: unknown;
  } | null;
  /** The session the callback created, or `null` when it created none, as on an error redirect. */
  readonly created: { readonly session: { readonly token: string }; readonly user: { readonly id: string } } | null;
  /**
   * Where the callback's response sends the browser, when it is a redirect.
   * A sign-in that went through is sent to its flow's return page; anything
   * else is a refusal, from the callback or a hook before this one.
   */
  readonly callbackLocation: string | undefined;
  /** The callback response's headers, as the callback and every earlier hook left them. */
  readonly responseHeaders: Headers | undefined;
  /**
   * Tells the hooks after this one that the request created no session, so
   * none of them acts on one: a plugin that hands a new session a credential
   * of its own reads it there.
   */
  readonly forgetNewSession: () => void;
  /** The names this server gives its session cookies. */
  readonly credentialCookies: readonly string[];
  readonly store: AppSignInStore;
  readonly deleteSession: (token: string) => Promise<void>;
  readonly logger: { error(message: string, ...args: unknown[]): void };
  /** This server's issuer, the one discovery publishes, sent to the app as `iss`. */
  readonly issuer: string;
  /** The server's error page, showing `code` and its message. */
  readonly errorPage: (code: AppSignInErrorCode) => string;
  /** `code`'s plain-language message, sent to the app as `error_description`. */
  readonly message: (code: AppSignInErrorCode) => string;
}

/**
 * Finishes an app sign-in inside the provider's callback (#1019): where the
 * browser goes next, or `undefined` to leave the callback's response as it
 * is. That is the answer when the callback isn't an app sign-in's, or created
 * no session, which then passes untouched, and when the sign-in was refused.
 *
 * The session the callback created belongs to the app, not the browser. Its
 * credentials come off the response, and the request forgets it created one,
 * before anything that can fail, and the session itself is deleted however
 * the hand-off ends. Every hook after this one then sees a callback that
 * signed no one in, so none of them reacts to the app's sign-in in the
 * browser: the anonymous plugin doesn't treat it as a guest's upgrade and
 * delete the guest, and the last-login-method cookie isn't set.
 *
 * The app gets a single-use code bound to its PKCE challenge instead, and the
 * browser is sent straight to the app, so no browser step follows the
 * callback: a tab closed at any point leaves no session behind, and a browser
 * that was already signed in keeps its own. A refusal gets no code: its
 * answer stands.
 *
 * Every redirect to the app carries `iss`, so the app can tell this server's
 * answer from another's (RFC 9207). Storage failing at this point is logged
 * and answered with `APP_SIGN_IN_UNAVAILABLE`: at the app, once the flow is
 * read, so it isn't left waiting on a sign-in that has already ended, and on
 * the error page before that.
 */
export async function handOffAppSignIn(handOff: AppSignInHandOff): Promise<string | undefined> {
  const flowId = handOff.oauthState?.serverContext?.[APP_SIGN_IN_FLOW_KEY];
  const created = handOff.created;

  if (typeof flowId !== 'string' || created === null) {
    return undefined;
  }

  if (handOff.responseHeaders !== undefined) {
    withoutSessionCredentials(handOff.responseHeaders, handOff.credentialCookies);
  }
  handOff.forgetNewSession();

  try {
    // Refused after the session was created. The flow stays, so a refusal
    // sent to the return page still reaches the app.
    if (handOff.callbackLocation !== appSignInReturnPage(flowId)) {
      return undefined;
    }

    let flow: Awaited<ReturnType<AppSignInStore['takeFlow']>>;
    try {
      flow = await handOff.store.takeFlow(flowId);
    } catch (error) {
      handOff.logger.error('Could not read the flow of an app sign-in', error);
      return handOff.errorPage(APP_SIGN_IN_UNAVAILABLE);
    }
    if (flow === null) {
      return handOff.errorPage(APP_SIGN_IN_FLOW_INVALID);
    }

    let code: string;
    try {
      code = await handOff.store.issueCode({ userId: created.user.id, codeChallenge: flow.codeChallenge });
    } catch (error) {
      // The flow is used up, so the app can't retry it: tell it to start over.
      handOff.logger.error('Could not store the code of an app sign-in', error);
      return appReturnUrl(flow.returnAddress, {
        error: APP_SIGN_IN_UNAVAILABLE,
        error_description: handOff.message(APP_SIGN_IN_UNAVAILABLE),
        state: flow.state,
        iss: handOff.issuer,
      });
    }

    return appReturnUrl(flow.returnAddress, { code, state: flow.state, iss: handOff.issuer });
  } finally {
    // Best effort: the session's token never left the server, and a failure
    // here must not replace the request's own outcome.
    await handOff.deleteSession(created.session.token).catch((error: unknown) => {
      handOff.logger.error('Could not delete the session an app sign-in handed over', error);
    });
  }
}
