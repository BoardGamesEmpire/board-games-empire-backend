/* eslint-disable @nx/enforce-module-boundaries */
import igdb from 'igdb-api-node';
import process from 'node:process';
import { GAME_FETCH_FIELDS } from '../../apps/igdb-gateway/src/app/igdb-requests/game.requests';
import { IGDBClient } from '../../apps/igdb-gateway/src/app/igdb/interfaces';
import { fetchAccessToken } from '../../apps/igdb-gateway/src/app/igdb/lib/fetch-access-token';
import { resolveLanguageIds } from '../../apps/igdb-gateway/src/app/mappers/language.mapper';

// This script is for ad-hoc testing and exploration of the IGDB API and related codes

const clientId = process.env.IGDB_CLIENT_ID;
const clientSecret = process.env.IGDB_CLIENT_SECRET;

async function main() {
  if (!clientId || !clientSecret) {
    throw new Error('IGDB client ID and secret must be provided');
  }
  const accessToken = await fetchAccessToken({ client_id: clientId!, client_secret: clientSecret! });
  const client = igdb(clientId, accessToken.access_token);
  // const gameData = await searchGamesRequest('catan', 10, 0, 'en-US')(client);

  // console.log(JSON.stringify(gameData, null, 2));

  // const gameSearchData = gameData.map(toGameSearchData);
  // console.log('Mapped game search data:', JSON.stringify(gameSearchData, null, 2));

  // client
  //   .fields(['*'])
  //   .limit(5)
  //   .request('/languages')
  //   .then((response) => {
  //     console.log(JSON.stringify(response.data, null, 2));
  //   });

  let builder = client
    .limit(1)
    // .offset(0)
    .fields([...GAME_FETCH_FIELDS]);
  builder = includeLanguageFilter(builder);

  builder
    .where(`language_supports.language = 7`) // English
    .search('half-life')
    .request('/games')
    .then((response) => {
      console.log(JSON.stringify(response.data, null, 2));
    });
}

function includeLanguageFilter(builder: IGDBClient, locale?: string, whereQuery?: string): IGDBClient {
  if (!locale) {
    if (whereQuery) {
      return builder.where(whereQuery);
    }

    return builder;
  }

  const languageIds = resolveLanguageIds(locale);
  if (languageIds.length === 0) {
    return builder;
  }

  return builder.where(
    `${whereQuery ? `${whereQuery} & ` : ''}(language_supports.language = (${languageIds.join(
      ',',
    )}) | language_supports.language = null)`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
