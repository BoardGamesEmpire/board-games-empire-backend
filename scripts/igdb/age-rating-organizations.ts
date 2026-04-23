/* eslint-disable @nx/enforce-module-boundaries */
import igdb from 'igdb-api-node';
import process from 'node:process';
import { fetchAccessToken } from '../../apps/igdb-gateway/src/app/igdb/lib/fetch-access-token';

// This script is for ad-hoc testing and exploration of the IGDB API and related codes

const clientId = process.env.IGDB_CLIENT_ID;
const clientSecret = process.env.IGDB_CLIENT_SECRET;

async function main() {
  if (!clientId || !clientSecret) {
    throw new Error('IGDB client ID and secret must be provided');
  }
  const accessToken = await fetchAccessToken({ client_id: clientId!, client_secret: clientSecret! });
  const client = igdb(clientId, accessToken.access_token);

  client
    .fields(['*'])
    .limit(25)
    .request('/age_rating_organizations')
    .then((response) => {
      console.log(JSON.stringify(response.data, null, 2));
    });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
