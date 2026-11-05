import { discardBody, type UpstreamFetch } from '@boardgamesempire/gateway-driver-contract';

export interface Credentials {
  client_id: string;
  client_secret: string;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

/** How long the token endpoint has to answer, body and all. */
export const TOKEN_TIMEOUT_MS = 10_000;

/**
 * Fetches a client-credentials access token from `tokenUrl`, through the
 * fetch the driver is handed (#1082). `tokenUrl` is Twitch's OAuth endpoint
 * unless configured otherwise (`IGDB_TOKEN_URL` in the gateway app, which
 * its e2e suite points at a local stub). Per IGDB/Twitch guidance, tokens
 * should NOT be proactively refreshed — wait for a 401 response, then call
 * this and retry.
 *
 * An endpoint that hasn't answered within `timeoutMs` fails the fetch, so a
 * stalled endpoint fails the gateway's boot, or the refresh every waiting
 * call shares, rather than hold it forever (#1082).
 *
 * @see https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#client-credentials-grant-flow
 */
export async function fetchAccessToken(
  upstream: UpstreamFetch,
  credentials: Credentials,
  tokenUrl: string = TWITCH_TOKEN_URL,
  timeoutMs: number = TOKEN_TIMEOUT_MS,
): Promise<TokenResponse> {
  // Appended, so a query the configured URL already carries is kept.
  const url = new URL(tokenUrl);
  for (const [name, value] of Object.entries({ ...credentials, grant_type: 'client_credentials' })) {
    url.searchParams.append(name, value);
  }

  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const response = await upstream(url.href, { method: 'POST', headers: {}, signal });

    if (!response.ok) {
      await discardBody(response);
      throw new Error(`Failed to obtain IGDB access token: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as TokenResponse;
  } catch (err) {
    if (signal.aborted) {
      throw new Error(`Failed to obtain IGDB access token: no answer within ${timeoutMs}ms`, { cause: err });
    }

    throw err;
  }
}
