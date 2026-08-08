import type { PrismaClient } from '@bge/database';
import type { Logger } from '@nestjs/common';
import { gameLengthsSeed } from './game-lengths.seed';
import { languagesSeed } from './languages.seed';
import { platformsSeed } from './platforms.seed';
import { rolesAndPermissionsSeed } from './roles-permissions.seed';
import { safeHttpPolicySeed } from './safe-http-policy.seed';
import { systemSettingsSeed } from './system-settings.seed';

export type Seeder = (prisma: PrismaClient, logger: Logger) => Promise<void>;

/**
 * The complete reference/catalog seed set, in application order.
 * Every seeder is an idempotent upsert and may re-run freely.
 */
export const SEEDERS: readonly Seeder[] = [
  gameLengthsSeed,
  languagesSeed,
  platformsSeed,
  rolesAndPermissionsSeed,
  safeHttpPolicySeed,
  systemSettingsSeed,
];

/**
 * Runs every seeder against the supplied client. Extracted from
 * `prisma/seed.ts` (#255) so callers other than the CLI wrapper can seed a
 * database in-process — and so #236's bootstrap orchestration can consume
 * this exact function for its reference-data phase rather than growing a
 * second seed path.
 *
 * Connection lifecycle belongs to the caller: this function neither
 * connects nor disconnects the client it is given.
 */
export async function runSeeds(prisma: PrismaClient, logger: Logger): Promise<void> {
  logger.log(`Starting database seeding... ${SEEDERS.length} seeds to run.`);

  for (const seed of SEEDERS) {
    try {
      logger.log(`Initializing ${seed.name}...`);
      await seed(prisma, logger);
      logger.log(`${seed.name} completed successfully.`);
    } catch (error) {
      logger.error(`Error initializing ${seed.name}:`);
      throw error;
    }
  }

  logger.log('All seeds completed successfully.');
}
