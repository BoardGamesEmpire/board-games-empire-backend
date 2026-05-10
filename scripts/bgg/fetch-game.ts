import { BggClient } from 'bgg-ts-client';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';

const apiKey = process.env.BGG_API_KEY;

const tmpDir = path.resolve('tmp');

async function main() {
  if (!apiKey) {
    throw new Error('BGG API key must be provided');
  }

  await fs.mkdir(tmpDir, { recursive: true });

  const client = BggClient.Create({ apiKey });
  const fetchResults = await client.thing.query({
    id: 13,
    stats: 1,
    versions: 1,
    type: ['boardgame'],
  });

  const outputPath = path.join(tmpDir, 'fetch-game-result.json');
  await fs.writeFile(outputPath, JSON.stringify(fetchResults, null, 2));
  console.log(`Fetch result written to ${outputPath}`);
}

main().catch((error) => {
  console.error('Error during BGG fetch:', error);
  process.exit(1);
});
