import type { Logger } from '@nestjs/common';
import type { ReconcilePlan, ReconcileResult } from '../catalog';
import type { PrismaClient } from '../client';
import { gameLengthsSeed } from './game-lengths.seed';
import { languagesSeed } from './languages.seed';
import { platformsSeed } from './platforms.seed';
import { rolesAndPermissionsSeed } from './roles-permissions.seed';
import { safeHttpPolicySeed } from './safe-http-policy.seed';
import { systemSettingsSeed } from './system-settings.seed';

export type Seeder = (prisma: PrismaClient, logger: Logger) => Promise<void>;

/**
 * The reference-data seeds, in application order. Every one is an idempotent
 * upsert and may re-run freely. The catalog reconcile is not among them: it is
 * `runSeeds`'s last phase, with a result and a port of its own.
 */
export const SEEDERS: readonly Seeder[] = [
  gameLengthsSeed,
  languagesSeed,
  platformsSeed,
  safeHttpPolicySeed,
  systemSettingsSeed,
];

export interface RunSeedsOptions {
  /**
   * Handed to the catalog reconcile: called once with the applied plan when it
   * wrote rows, never when it did not. The boot sequence passes its cache
   * flush; the seed CLI has no Redis and passes nothing.
   */
  readonly invalidate?: (plan: ReconcilePlan) => Promise<void>;
}

export interface SeedsReport {
  /** The reference seeds that ran, by function name, in order. */
  readonly seeds: readonly string[];
  /** What the catalog reconcile found and wrote. */
  readonly reconcile: ReconcileResult;
}

/**
 * Runs the reference seeds, then reconciles the catalog, against the supplied
 * client. Extracted from the CLI wrapper (#255, now `src/seed-cli.ts`) so
 * callers other than it can seed a database in-process, and moved into
 * `@bge/database` (#236) so the boot sequence can import it: `@bge/bootstrap`
 * calls this exact function for its seeds phase rather than growing a second
 * seed path.
 *
 * The reconcile runs last, after everything the catalog could one day refer
 * to is in place; nothing after it depends on it today. Connection lifecycle
 * belongs to the caller: this function neither connects nor disconnects the
 * client it is given.
 */
export async function runSeeds(
  prisma: PrismaClient,
  logger: Logger,
  options: RunSeedsOptions = {},
): Promise<SeedsReport> {
  logger.log(`Starting database seeding... ${SEEDERS.length} reference seeds, then the catalog reconcile.`);

  const seeds: string[] = [];
  for (const seed of SEEDERS) {
    try {
      logger.log(`Initializing ${seed.name}...`);
      await seed(prisma, logger);
      logger.log(`${seed.name} completed successfully.`);
      seeds.push(seed.name);
    } catch (error) {
      logger.error(`Error initializing ${seed.name}:`);
      throw error;
    }
  }

  const reconcile = await rolesAndPermissionsSeed(prisma, logger, options.invalidate);

  logger.log('All seeds completed successfully.');
  return { seeds, reconcile };
}
