import type { makeRedisConfig } from '@bge/redis';
import type { BootstrapLogger, Migrator } from './ports';

export const BOOTSTRAP_OPTIONS = Symbol('BOOTSTRAP_OPTIONS');
/** The api's `CacheFlush`; registered only when {@link BootstrapModuleOptions.cache} is given. */
export const CACHE_FLUSH = Symbol('CACHE_FLUSH');

export interface BootstrapCacheOptions {
  /**
   * The connection the api's cache store uses: `makeRedisConfig(...)`'s
   * `config` and `validationSchema`, loaded into this context's `ConfigModule`
   * so the same `REDIS_*` variables reach the same server and database.
   */
  readonly redis: ReturnType<typeof makeRedisConfig>;
  /**
   * The physical key globs to remove after a reconcile that wrote rows: the
   * cache store's namespace in front of the logical key, for example
   * `api:cache:bge:user:permissions:*`. Composed by the entrypoint, which owns
   * both halves; this module knows neither.
   */
  readonly flushPatterns: readonly string[];
}

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
  /**
   * The api's cache, passed like the migrator (#236): only the process that
   * runs the DML phases has caches to flush after them. Absent for `worker`,
   * `gateway-coordinator` and `gateway-worker`, which then need no `REDIS_*`
   * to boot through this context.
   */
  readonly cache?: BootstrapCacheOptions;
}
