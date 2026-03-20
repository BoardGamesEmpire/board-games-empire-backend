/* eslint-disable @nx/enforce-module-boundaries */
import igdb from 'igdb-api-node';
import { searchGamesRequest } from '../apps/igdb-gateway/src/app/igdb-requests/game.requests';
import { fetchAccessToken } from '../apps/igdb-gateway/src/app/igdb/lib/fetch-access-token';
import { toGameSearchData } from '../apps/igdb-gateway/src/app/mappers/game.mapper';

const clientId = process.env.IGDB_CLIENT_ID;
const clientSecret = process.env.IGDB_CLIENT_SECRET;

async function main() {
  if (!clientId || !clientSecret) {
    throw new Error('IGDB client ID and secret must be provided');
  }
  const accessToken = await fetchAccessToken({ client_id: clientId!, client_secret: clientSecret! });
  const client = igdb(clientId, accessToken.access_token);
  const gameData = await searchGamesRequest('catan', 10, 0, 'en-US')(client);

  // console.log(JSON.stringify(gameData, null, 2));

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

const g = [
  {
    id: 1022,
    age_ratings: [35499, 47172, 47483, 64807, 226926],
    alternative_names: [37766, 37767, 120471, 71141, 71139, 118554, 119301, 191961],
    artworks: [52597, 172464, 172465, 52598, 52596, 52599],
    bundles: [45139, 152361, 213361, 213597],
    cover: {
      id: 86202,
      url: '//images.igdb.com/igdb/image/upload/t_thumb/co1uii.jpg',
    },
    created_at: 1326279198,
    external_games: [23315, 23616, 146124, 189136, 221005, 2594627, 245672, 2594170],
    first_release_date: 509328000,
    franchises: [596],
    game_modes: [1],
    genres: [
      {
        id: 31,
        name: 'Adventure',
      },
    ],
    involved_companies: [180342, 197987, 225320],
    keywords: [
      538, 1181, 1208, 2209, 6189, 23793, 26191, 26906, 27629, 29745, 29768, 29770, 29771, 30367, 30490, 30703, 31177,
      34033, 38565, 39459, 39990, 39991, 39993, 40223, 41037, 41038, 41039, 41042, 41043, 41044, 41045, 41046, 41047,
      41048, 41052, 41053, 41535, 48315, 48374, 48593, 48610, 48611, 48612, 49212,
    ],
    name: 'The Legend of Zelda',
    platforms: [
      {
        id: 51,
        name: 'Family Computer Disk System',
      },
      {
        id: 37,
        name: 'Nintendo 3DS',
      },
      {
        id: 5,
        name: 'Wii',
      },
      {
        id: 99,
        name: 'Family Computer',
      },
      {
        id: 41,
        name: 'Wii U',
      },
      {
        id: 18,
        name: 'Nintendo Entertainment System',
      },
    ],
    player_perspectives: [3],
    rating: 80.55756130689426,
    rating_count: 711,
    release_dates: [
      548346, 514482, 514483, 514484, 514496, 514497, 514488, 514498, 514492, 514494, 514493, 514485, 514487, 514491,
      514486, 514490, 514495,
    ],
    screenshots: [951192, 951195, 951196, 951197, 951198, 951189, 951193, 951194, 951190, 951191],
    similar_games: [1070, 358, 19164, 1802, 1074, 1025, 385, 81249, 2899, 103303],
    slug: 'the-legend-of-zelda',
    storyline:
      'In one of the darkest times in the Kingdom of Hyrule, a young boy named Link takes on an epic quest to restore the fragmented Triforce of Wisdom and save the Princess Zelda from the clutches of the evil Ganon.',
    summary:
      "The Legend of Zelda is the first title in the Zelda series, it has marked the history of video games particularly for it's game mechanics and universe. The player controls Link and must make his way through the forests, graveyards, plains and deserts of the Otherworld to find the secret entrances to the eight dungeons and try to restore the broken Triforce. Among the game's mechanics, it was the first time we saw a continuous world that could be freely explored, power-ups that permanently enhanced the main character's abilities and a battery save feature that allowed players to keep their progress instead of having to start over. The gameplay balanced action sequences with discovery, secrets and exploration.",
    tags: [
      1, 17, 38, 268435487, 536871450, 536872093, 536872120, 536873121, 536877101, 536894705, 536897103, 536897818,
      536898541, 536900657, 536900680, 536900682, 536900683, 536901279, 536901402, 536901615, 536902089, 536904945,
      536909477, 536910371, 536910902, 536910903, 536910905, 536911135, 536911949, 536911950, 536911951, 536911954,
      536911955, 536911956, 536911957, 536911958, 536911959, 536911960, 536911964, 536911965, 536912447, 536919227,
      536919286, 536919505, 536919522, 536919523, 536919524, 536920124,
    ],
    themes: [1, 17, 38],
    total_rating: 80.55756130689426,
    total_rating_count: 711,
    updated_at: 1773522549,
    url: 'https://www.igdb.com/games/the-legend-of-zelda',
    videos: [81432],
    websites: [797650, 110158, 512336, 514042, 575037],
    checksum: '245d1f97-182f-d4eb-03e7-78d1e0ee456e',
    remakes: [38319, 134500],
    ports: [172501, 18066],
    language_supports: [491272, 685772],
    game_localizations: [3047, 25984],
    collections: [106],
    game_type: 0,
  },
];
