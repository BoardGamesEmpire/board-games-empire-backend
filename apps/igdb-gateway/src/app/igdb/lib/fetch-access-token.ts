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

/**
 * Fetches a client-credentials access token from `tokenUrl`, which is Twitch's
 * OAuth endpoint unless configured otherwise (`IGDBConfig.tokenUrl`). The
 * default serves the `scripts/igdb` maintenance scripts, which pass none. Per
 * IGDB/Twitch guidance, tokens should NOT be proactively refreshed — wait for
 * a 401 response, then call this and retry.
 *
 * @see https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#client-credentials-grant-flow
 */
export async function fetchAccessToken(
  credentials: Credentials,
  tokenUrl: string = TWITCH_TOKEN_URL,
): Promise<TokenResponse> {
  // Appended, so a query the configured URL already carries is kept.
  const url = new URL(tokenUrl);
  for (const [name, value] of Object.entries({ ...credentials, grant_type: 'client_credentials' })) {
    url.searchParams.append(name, value);
  }

  const response = await fetch(url, {
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(`Failed to obtain IGDB access token: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<TokenResponse>;
}
