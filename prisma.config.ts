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
    // The scratch database `npm run db:migrate:check` replays the migrations
    // into, to compare them with the models (#586). `migrate dev` uses it too
    // when it is set, and makes a temporary one when it isn't. Prisma empties it
    // on every run, so it must never be the main database. `migrate dev` refuses
    // one that is; for `migrate diff`, the check's script does
    // (libs/scripts/src/migration-check).
    shadowDatabaseUrl: process.env['SHADOW_DATABASE_URL'] || undefined,
  },
});
