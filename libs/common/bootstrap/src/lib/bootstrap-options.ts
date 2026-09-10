import type { BootstrapLogger, Migrator } from './ports';

export const BOOTSTRAP_OPTIONS = Symbol('BOOTSTRAP_OPTIONS');

export interface MigratorContext {
  readonly databaseUrl: string;
  readonly logger: BootstrapLogger;
}

export interface BootstrapModuleOptions {
  /** Names this process in `pg_stat_activity` while it holds the lock, e.g. `api`. */
  readonly applicationName: string;
  /**
   * Builds the migrator. Only the api build passes one (#236); its
   * presence also makes this process the single writer of the DML phases.
   * Processes without it check the schema and wait.
   */
  readonly migrator?: (context: MigratorContext) => Migrator;
  /** One budget for taking the lock and waiting for the schema; see `DEFAULT_WAIT_MS`. */
  readonly waitMs?: number;
  readonly schemaPollMs?: number;
}
