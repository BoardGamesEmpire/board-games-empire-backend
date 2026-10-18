import 'dotenv/config';
import * as path from 'node:path';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: path.join('prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'npx tsx libs/database/src/seed-cli.ts',
  },
  datasource: {
    // The migration credential, as the api's bootstrap reads it (#445): its
    // own variable when set, `DATABASE_URL` otherwise, empty counting as unset.
    // Migrate needs a direct connection or session pooling.
    url: process.env['DATABASE_MIGRATION_URL'] || process.env['DATABASE_URL'],
  },
});
