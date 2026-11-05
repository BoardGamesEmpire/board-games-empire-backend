import { fetchAccessToken, IgdbQuery } from '@bge/gateway-driver-igdb';
import process from 'node:process';

// This script is for ad-hoc testing and exploration of the IGDB API and related codes

const clientId = process.env.IGDB_CLIENT_ID;
const clientSecret = process.env.IGDB_CLIENT_SECRET;

async function main() {
  if (!clientId || !clientSecret) {
    throw new Error('IGDB client ID and secret must be provided');
  }
  const accessToken = await fetchAccessToken(fetch, { client_id: clientId!, client_secret: clientSecret! });
  const client = new IgdbQuery({ fetch, clientId, accessToken: accessToken.access_token });

  client
    .fields(['*'])
    .limit(50)
    .request('/game_statuses')
    .then((response) => {
      console.log(JSON.stringify(response.data, null, 2));
    });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
