import type { LoggerService } from '@nestjs/common';
import { decodeJwt } from 'jose';
import type { OidcProviderConfig } from './configuration/oidc-providers';
import { mergeProviderClaims, type ProviderClaims, type ProviderProfile } from './provider-claims';

/** How long a request to a sign-in provider may take: its discovery document, or UserInfo (#993). */
export const PROVIDER_REQUEST_TIMEOUT_MS = 10_000;

/** A discovery document names at least one of these; an answer naming neither is not one (#993). */
const DISCOVERY_FIELDS = ['issuer', 'authorization_endpoint'] as const;

/** What {@link createProviderUserInfo} needs from outside (#993). */
export interface ProviderUserInfoDeps {
  readonly logger: Pick<LoggerService, 'warn'>;
  /** Defaults to the global fetch, looked up on each call. */
  readonly fetch?: typeof fetch;
}

/** A sign-in provider's `getUserInfo`: the profile to sign in with, or `null` to refuse (#993). */
export type ProviderUserInfo = (tokens: {
  readonly accessToken?: string;
  readonly idToken?: string;
}) => Promise<ProviderProfile | null>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An ID token's claims, or `undefined` when there is none or it can't be decoded. */
function decodeIdToken(idToken: string | undefined): ProviderClaims | undefined {
  if (!idToken) {
    return undefined;
  }

  try {
    return decodeJwt(idToken);
  } catch {
    return undefined;
  }
}

/** The UserInfo endpoint a discovery document lists, or `undefined` when it lists none that parses as a URL. */
function userInfoEndpointOf(document: Record<string, unknown>): string | undefined {
  const listed = document['userinfo_endpoint'];
  if (typeof listed !== 'string') {
    return undefined;
  }

  try {
    return new URL(listed).href;
  } catch {
    return undefined;
  }
}

/**
 * The `getUserInfo` a sign-in provider's genericOAuth config is given (#993):
 * the ID token's claims merged with the provider's UserInfo answer, by
 * {@link mergeProviderClaims}.
 *
 * better-auth's own reading answers the ID token's claims alone whenever they
 * carry `sub` and `email`, so a provider that confirms the email only at
 * UserInfo had its users refused as unverified. OpenID Connect returns the
 * `profile` and `email` scope claims from UserInfo for the code flow, and
 * sends only some of them in the ID token, so UserInfo is asked whenever the
 * provider lists it, even when the ID token would do. When it can't be read,
 * the ID token's claims answer alone.
 *
 * better-auth gives this function only the tokens, not the endpoint its own
 * discovery found, so it reads the provider's discovery document itself. The
 * read starts when this is created, as better-auth's own discovery does when
 * the instance is built, so the first sign-in doesn't wait on it. One read
 * serves every sign-in, concurrent ones included. A failed read is not kept,
 * so the next sign-in tries again.
 *
 * By the time this runs, better-auth has verified the ID token against the
 * provider's JWKS when the provider publishes one, so here it is only
 * decoded. Without a JWKS the token is unverified, but better-auth takes it
 * only from the provider's token endpoint, never from the browser, and OpenID
 * Connect Core 3.1.3.7 lets that connection's TLS check stand in for the
 * signature.
 *
 * Both requests go out through `fetch`, as better-auth's own requests to the
 * provider do, not through the outbound HTTP policy. Whether provider
 * requests should, `deps.fetch` being the place to switch them, is #982.
 *
 * A UserInfo answer for another subject answers `null`, never a throw:
 * better-auth catches nothing around this call, so a throw would leave the
 * callback with no redirect, while `null` redirects with
 * `unable_to_get_user_info`. Warnings name the provider and what went wrong,
 * never a claim's value.
 */
export function createProviderUserInfo(
  provider: Pick<OidcProviderConfig, 'id' | 'discoveryUrl'>,
  deps: ProviderUserInfoDeps,
): ProviderUserInfo {
  const warn = (problem: string) => deps.logger.warn(`Sign-in provider "${provider.id}": ${problem}`);

  /** A JSON object from a GET, or `undefined` when the request fails, isn't answered 2xx, or answers anything else. */
  const getJsonObject = async (url: string, headers: Record<string, string>) => {
    const fetchJson = deps.fetch ?? globalThis.fetch;
    try {
      const response = await fetchJson(url, { headers, signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS) });
      if (!response.ok) {
        // Unread, the body would hold its connection until the timeout.
        await response.body?.cancel();
        return undefined;
      }

      const body: unknown = await response.json();
      return isRecord(body) ? body : undefined;
    } catch {
      return undefined;
    }
  };

  // Leaving `sub` out of UserInfo is how a provider answers, not a passing
  // fault, so it is said once rather than on every sign-in.
  let setAsideWarned = false;
  // So is a UserInfo that can't be read, such as a 401 for a missing scope or
  // a signed answer, so that is said once until UserInfo answers again.
  let userInfoFailing = false;

  // An answer that names neither an issuer nor an authorization endpoint,
  // such as a proxy's JSON error while the provider starts, is a failed read:
  // kept, it would stop UserInfo being asked until a restart. One that names
  // either is a discovery document, as better-auth takes it: it checks the
  // issuer only when there is one, and builds no provider without an
  // authorization endpoint.
  const readEndpoint = async (): Promise<string | undefined> => {
    const document = await getJsonObject(provider.discoveryUrl, { Accept: 'application/json' });
    if (document === undefined || !DISCOVERY_FIELDS.some((field) => typeof document[field] === 'string')) {
      endpointRead = undefined;
      warn("its discovery document couldn't be read, so UserInfo isn't asked");
      return undefined;
    }

    return userInfoEndpointOf(document);
  };

  let endpointRead: Promise<string | undefined> | undefined = readEndpoint();

  return async (tokens) => {
    const idToken = decodeIdToken(tokens.idToken);
    const endpoint = await (endpointRead ??= readEndpoint());

    let userInfo: ProviderClaims | undefined;
    let userInfoFailed = false;
    if (endpoint !== undefined && tokens.accessToken) {
      userInfo = await getJsonObject(endpoint, {
        Authorization: `Bearer ${tokens.accessToken}`,
        Accept: 'application/json',
      });
      userInfoFailed = userInfo === undefined;
      if (!userInfoFailed) {
        userInfoFailing = false;
      }
    }

    const merged = mergeProviderClaims(idToken, userInfo);
    switch (merged.outcome) {
      case 'subject-mismatch':
        warn('UserInfo answered for a different subject than the ID token; sign-in refused');
        return null;
      case 'none':
        if (userInfoFailed) {
          warn("UserInfo couldn't be read, and there's no ID token to sign in with instead");
        }
        return null;
      case 'profile':
        if (userInfoFailed) {
          if (!userInfoFailing) {
            userInfoFailing = true;
            warn(
              "UserInfo couldn't be read; using the ID token's claims alone, and this isn't logged again until it answers",
            );
          }
        } else if (merged.userInfoSetAside && !setAsideWarned) {
          setAsideWarned = true;
          warn("UserInfo carries no subject, so its answers are set aside; this isn't logged again");
        }
        return merged.profile;
    }
  };
}
