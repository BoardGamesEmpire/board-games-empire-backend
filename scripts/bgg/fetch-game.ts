import { BggClient } from 'bgg-ts-client';
import process from 'node:process';

const apiKey = process.env.BGG_API_KEY;

async function main() {
  if (!apiKey) {
    throw new Error('BGG API key must be provided');
  }
  const client = BggClient.Create({ apiKey });
  const fetchResults = await client.thing.query({
    id: 13,
    stats: 1,
    type: ['boardgame'],
  });
  console.log(JSON.stringify(fetchResults, null, 2));
}

main().catch((error) => {
  console.error('Error during BGG fetch:', error);
  process.exit(1);
});
