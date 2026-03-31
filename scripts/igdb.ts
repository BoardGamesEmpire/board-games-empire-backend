/* eslint-disable @nx/enforce-module-boundaries */
import igdb from 'igdb-api-node';
import { searchGamesRequest } from '../apps/igdb-gateway/src/app/igdb-requests/game.requests';
import { fetchAccessToken } from '../apps/igdb-gateway/src/app/igdb/lib/fetch-access-token';
import { toGameSearchData } from '../apps/igdb-gateway/src/app/mappers/game.mapper';

// This script is for ad-hoc testing and exploration of the IGDB API and related codes

const clientId = process.env.IGDB_CLIENT_ID;
const clientSecret = process.env.IGDB_CLIENT_SECRET;

async function main() {
  if (!clientId || !clientSecret) {
    throw new Error('IGDB client ID and secret must be provided');
  }
  const accessToken = await fetchAccessToken({ client_id: clientId!, client_secret: clientSecret! });
  const client = igdb(clientId, accessToken.access_token);
  const gameData = await searchGamesRequest('catan', 10, 0, 'en-US')(client);

  console.log(JSON.stringify(gameData, null, 2));

  const gameSearchData = gameData.map(toGameSearchData);
  console.log('Mapped game search data:', JSON.stringify(gameSearchData, null, 2));

  // client
  //   .fields(['*'])
  //   .limit(50)
  //   .request('/languages')
  //   .then((response) => {
  //     console.log(JSON.stringify(response.data, null, 2));
  //   });

  // client
  //   .limit(10)
  //   .offset(0)
  //   .fields([
  //     'name',
  //     'url',
  //     'genres.name',
  //     'platforms.*',
  //     'platforms.platform_type.*',
  //     'cover.url',
  //     'themes.name',
  //     'language_supports.language.*',
  //   ])
  //   .where('version_parent = null')
  //   .where(`language_supports.language = 7`) // English
  //   .search('zelda')
  //   .request('/games')
  //   .then((response) => {
  //     console.log(JSON.stringify(response.data, null, 2));
  //   });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
