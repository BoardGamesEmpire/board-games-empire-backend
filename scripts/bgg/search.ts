import { BggClient } from 'bgg-ts-client';
import process from 'node:process';

const apiKey = process.env.BGG_API_KEY;

async function main() {
  if (!apiKey) {
    throw new Error('BGG API key must be provided');
  }
  const client = BggClient.Create({ apiKey });
  const searchResults = await client.search.query({
    query: 'catan',
    exact: 0,
    type: ['boardgame', 'boardgameexpansion'],
  });
  console.log(JSON.stringify(searchResults, null, 2));
}

main().catch((error) => {
  console.error('Error during BGG search:', error);
  process.exit(1);
});
