import {
  applyDataMigrations,
  DATA_MIGRATIONS,
  type DataMigrationEntry,
  type DataMigrationsClient,
} from '@bge/database';
import { Logger } from '@nestjs/common';
import type { CacheFlush, DataMigrationsPhase, DataMigrationsSummary } from './ports';

export interface RegistryDataMigrationsOptions {
  /** The entries to apply; the shipped registry unless a test supplies its own. */
  readonly entries?: readonly DataMigrationEntry[];
  /** The api's cache flush; absent in a build without one. */
  readonly flush?: CacheFlush;
  /** Where the entries log; a Nest `Logger` named `DataMigrations` by default. */
  readonly logger?: Logger;
}

/**
 * The data-migrations phase is `applyDataMigrations` over the shipped
 * registry (#236): the one apply path, the same the ledger's unit and e2e
 * specs drive with registries of their own. Runs after the seeds, under the
 * lock, in the api only, and is handed the cache flush the seeds phase hands
 * the reconcile, so an entry that rewrote what the ability graphs are built
 * from is not served from a cache that predates it. What it applied, the rows
 * it does not know and whether it flushed go into the boot summary.
 */
export class RegistryDataMigrations implements DataMigrationsPhase {
  private readonly entries: readonly DataMigrationEntry[];
  private readonly logger: Logger;

  constructor(
    private readonly client: DataMigrationsClient,
    private readonly options: RegistryDataMigrationsOptions = {},
  ) {
    this.entries = options.entries ?? DATA_MIGRATIONS;
    this.logger = options.logger ?? new Logger('DataMigrations');
  }

  async run(): Promise<DataMigrationsSummary> {
    const { flush } = this.options;
    const result = await applyDataMigrations(this.client, this.entries, this.logger, {
      invalidate: flush ? () => this.flushCaches(flush) : undefined,
    });
    return { applied: result.applied, unknown: result.unknown, cachesFlushed: result.invalidated };
  }

  private async flushCaches(flush: CacheFlush): Promise<void> {
    const removed = await flush.flush();
    this.logger.log(`Data migrations applied: ${removed} cached ability and API-key scope graph(s) flushed.`);
  }
}
