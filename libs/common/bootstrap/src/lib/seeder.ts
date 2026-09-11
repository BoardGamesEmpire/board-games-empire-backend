import type { PrismaClient } from '@bge/database';
import { reconcileCounts } from '@bge/database';
import { runSeeds } from '@bge/database/seeds';
import { Logger } from '@nestjs/common';
import type { CacheFlush, ReconcileSummary, SeedsPhase } from './ports';

export interface RunSeedsSeederOptions {
  /** The api's cache flush; absent in a build without one. */
  readonly flush?: CacheFlush;
  /** Where the seeds log; a Nest `Logger` named `Seeds` by default. */
  readonly logger?: Logger;
}

/**
 * The seeds phase is `runSeeds`, the one seed path (#236): the reference
 * seeds, then the catalog reconcile, which is handed the cache flush as its
 * invalidation port so a reconcile that wrote rows evicts every cached ability
 * graph before the api serves a request. What the reconcile wrote comes back
 * as counts for the boot summary. A flush that fails rejects with what it had
 * removed; the reconciler logs that and carries on, the writes being committed.
 */
export class RunSeedsSeeder implements SeedsPhase {
  private readonly logger: Logger;

  constructor(
    private readonly client: PrismaClient,
    private readonly options: RunSeedsSeederOptions = {},
  ) {
    this.logger = options.logger ?? new Logger('Seeds');
  }

  async run(): Promise<ReconcileSummary> {
    const { flush } = this.options;
    const report = await runSeeds(this.client, this.logger, {
      invalidate: flush ? () => this.flushCaches(flush) : undefined,
    });

    // Counting the plan is counting the writes: the apply compares every
    // statement's row count with the plan and rolls back on a difference.
    return { ...reconcileCounts(report.reconcile.plan), cachesFlushed: report.reconcile.invalidated };
  }

  private async flushCaches(flush: CacheFlush): Promise<void> {
    const removed = await flush.flush();
    this.logger.log(`Catalog reconcile wrote rows: ${removed} cached ability and API-key scope graph(s) flushed.`);
  }
}
