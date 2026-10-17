import { AuditContextService, SystemActorScope } from '@bge/actor-context';
import { DatabaseService } from '@bge/database';
import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InviteService } from '../invite.service';

const SWEEP_INTERVAL_NAME = 'invite-expiry-sweep';
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly; reads and transitions judge expiry by the clock meanwhile
// Per outstanding status, so one batch expires at most twice this. A short
// transaction holds few row locks, which makes a deadlock with a household
// delete's bulk revoke, locking the same overdue rows, rarer.
const SWEEP_BATCH_SIZE = 500;

/**
 * Stamps `Expired` on the outstanding invites whose window has closed and that
 * nothing has stamped since (#165). Nothing waits on it: reads compute expiry,
 * transitions refuse an expired invite with 410, and a create stamps the rows
 * in its way. The sweep converges the stored status and announces
 * `invite.expired` for the invites nobody touched.
 *
 * Worker-only, through `InviteExpirySweepModule`, so the interval runs in one
 * process. The api registers `ScheduleModule` too, which is why the interval
 * is not on `InvitesModule`. `invite.expired` therefore comes from two
 * processes: the worker announces the sweep's, and the api a refused
 * transition's and a create's. A listener for it has to be registered in both.
 *
 * Runs as the system actor, announcements included, so each audit row names
 * the sweep. A backlog drains in one run, in batches of one transaction each,
 * each announced after its commit. A failed batch ends the run: the scheduler
 * logs it, the batches before it stay committed and announced, and the next
 * run picks up the rest. Overlapping runs, or two workers, are safe, since the
 * status guard hands each row to one of them.
 *
 * At shutdown a run finishes the batch in flight and starts no other. The
 * audit listener detaches and the pool ends in `onApplicationShutdown`, which
 * Nest runs only after this class's `beforeApplicationShutdown` resolves, so
 * that last batch still commits on a live pool, and its announcements reach
 * the audit listener while it is still attached. The listener saves its rows
 * without being awaited, though, so a save that hasn't reached the pool by
 * the time it ends is lost. That gap is every listener's, not the sweep's
 * alone, and #738 tracks making the pool wait for those saves.
 */
@Injectable()
export class InviteExpirySweepService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(InviteExpirySweepService.name);
  /** Set once shutdown begins; no batch starts after it. */
  private stopping = false;
  /** The runs in flight, which shutdown waits for. */
  private readonly running = new Set<Promise<unknown>>();

  constructor(
    private readonly db: DatabaseService,
    private readonly invites: InviteService,
    private readonly audit: AuditContextService,
    private readonly systemActorScope: SystemActorScope,
  ) {}

  @Interval(SWEEP_INTERVAL_NAME, SWEEP_INTERVAL_MS)
  async sweepOnInterval(): Promise<void> {
    await this.systemActorScope.run(SWEEP_INTERVAL_NAME, () => this.runSweep());
  }

  /**
   * Public for tests / admin tooling. Refuses to run outside an actor scope,
   * where every `invite.expired` would be audited with no actor.
   */
  async runSweep(): Promise<{ expired: number }> {
    this.audit.getActorOrThrow();

    const run = this.drain();
    this.running.add(run);

    try {
      return await run;
    } finally {
      this.running.delete(run);
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    // A failed batch is the run's to report; shutdown only waits for it.
    await Promise.allSettled(this.running);
  }

  private async drain(): Promise<{ expired: number }> {
    let expired = 0;

    try {
      while (!this.stopping) {
        const { count, events, drained } = await this.db.$transaction((tx) =>
          this.invites.expireOutstandingWithin(tx, { limit: SWEEP_BATCH_SIZE }),
        );

        this.invites.emit(events);
        expired += count;

        // Not `count < SWEEP_BATCH_SIZE`: a rival settling part of a full read
        // leaves the count short with more still overdue.
        if (drained) {
          break;
        }
      }
    } finally {
      // Also when a batch failed: the ones before it are committed and announced.
      if (expired > 0) {
        this.logger.log(`Invite expiry sweep expired ${expired} invite(s)`);
      }
    }

    return { expired };
  }
}
