import { SystemActorScope } from '@bge/actor-context';
import { DatabaseService } from '@bge/database';
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

const SWEEP_INTERVAL_NAME = 'audit-log-retention-sweep';
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly; retention granularity is days
const DAY_MS = 24 * 60 * 60 * 1000;
// The first sweep after a retention change can face an unbounded backlog; a
// single UPDATE over millions of rows would hold one long row-locking
// transaction. Id-batches keep each write bounded; the backlog drains across
// iterations (and, worst case, across hourly ticks).
const SWEEP_BATCH_SIZE = 5_000;

/**
 * Soft-delete retention sweep for audit rows, mirroring the media
 * contribution sweep: worker-only (where ScheduleModule + AuditRetentionModule
 * are present) so it runs once, inside a `system` actor scope.
 *
 * Retention is the `SystemSetting.auditLogRetentionDays` singleton field.
 * Null (the default) means unlimited retention — the sweep is a no-op. Rows
 * past retention are stamped `deletedAt` and drop out of the admin read path;
 * hard purge (space reclaim) is deliberately deferred until it's a need.
 */
@Injectable()
export class AuditRetentionService {
  private readonly logger = new Logger(AuditRetentionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly systemActorScope: SystemActorScope,
  ) {}

  @Interval(SWEEP_INTERVAL_NAME, SWEEP_INTERVAL_MS)
  async sweepOnInterval(): Promise<void> {
    await this.systemActorScope.run(SWEEP_INTERVAL_NAME, () => this.runSweep(new Date()));
  }

  /** Public for tests / admin tooling. */
  async runSweep(now: Date): Promise<{ softDeleted: number }> {
    const settings = await this.db.systemSetting.findFirst({
      select: { auditLogRetentionDays: true },
    });

    const retentionDays = settings?.auditLogRetentionDays ?? null;
    // Null means unlimited. Guard non-positive values too: a 0 or negative
    // retention would put the cutoff at/after `now` and soft-delete the entire
    // trail — treat it as "unlimited / misconfigured" and no-op rather than
    // silently wiping the audit log.
    if (retentionDays === null || retentionDays <= 0) {
      if (retentionDays !== null) {
        this.logger.warn(
          `Ignoring non-positive auditLogRetentionDays (${retentionDays}); retention sweep skipped. ` +
            `Set a positive value or null (unlimited).`,
        );
      }
      return { softDeleted: 0 };
    }

    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
    let softDeleted = 0;

    for (;;) {
      const batch = await this.db.auditLog.findMany({
        where: { deletedAt: null, occurredAt: { lt: cutoff } },
        select: { id: true },
        // Oldest first: a stable, index-aligned path (occurredAt is indexed)
        // for large backlogs, and each bounded batch clears the tail of the
        // range the next iteration re-scans.
        orderBy: { occurredAt: 'asc' },
        take: SWEEP_BATCH_SIZE,
      });

      if (batch.length === 0) {
        break;
      }

      const { count } = await this.db.auditLog.updateMany({
        // Re-assert `deletedAt: null` so a row soft-deleted concurrently
        // (e.g. an overlapping manual run) is not rewritten or double-counted.
        where: { id: { in: batch.map((row) => row.id) }, deletedAt: null },
        data: { deletedAt: now },
      });
      softDeleted += count;

      if (batch.length < SWEEP_BATCH_SIZE) {
        break;
      }
    }

    if (softDeleted > 0) {
      this.logger.log(`Audit retention sweep soft-deleted ${softDeleted} row(s) older than ${retentionDays} day(s)`);
    }

    return { softDeleted };
  }
}
