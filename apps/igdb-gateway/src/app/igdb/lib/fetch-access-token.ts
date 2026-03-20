const TOKEN_URI = 'https://id.twitch.tv/oauth2/token';

interface Credentials {
  client_id: string;
  client_secret: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

/**
 * Fetches a client-credentials access token from Twitch's OAuth endpoint.
 * Per IGDB/Twitch guidance, tokens should NOT be proactively refreshed —
 * wait for a 401 response, then call this and retry.
 *
 * @see https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#client-credentials-grant-flow
 */
export async function fetchAccessToken(credentials: Credentials): Promise<TokenResponse> {
  const searchParams = new URLSearchParams({
    ...credentials,
    grant_type: 'client_credentials',
  });
  const url = `${TOKEN_URI}?${searchParams}`;

  const response = await fetch(url, {
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(`Failed to obtain IGDB access token: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<TokenResponse>;
}
