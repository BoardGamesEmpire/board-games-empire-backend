import type { MigrationState, MigrationStateKind } from '@bge/database';
import { classifyMigrationState, DEVELOPMENT_DATABASE_RESET_LINE, divergedFixLines } from '@bge/database';
import type { Span, Tracer } from '@opentelemetry/api';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { MigrationCredential } from './migration-credential';
import { DATABASE_URL_VARIABLE, MIGRATION_URL_VARIABLE } from './migration-credential';
import type {
  BootstrapLock,
  BootstrapLogger,
  Clock,
  DataMigrationsPhase,
  DataMigrationsSummary,
  Migrator,
  ReconcileSummary,
  SchemaLedger,
  SeedsPhase,
} from './ports';
import { DEFAULT_WAIT_MS, systemClock } from './ports';

/** How often a waiting process re-reads the ledger. */
export const DEFAULT_SCHEMA_POLL_MS = 5_000;

export interface BootstrapSequenceOptions {
  readonly clock?: Clock;

  /** Runs after the seeds, in the process that ran them. See {@link DataMigrationsPhase}. */
  readonly dataMigrations: DataMigrationsPhase;

  /** The migrations this build was generated from, in apply order. */
  readonly expected: readonly string[];

  readonly ledger: SchemaLedger;
  readonly lock: BootstrapLock;
  readonly logger: BootstrapLogger;

  /** Where the migrator's URL came from; named in the summary and in the refusals after migrating. */
  readonly migrationCredential?: MigrationCredential;

  /** Present only in the api build. See {@link Migrator}. */
  readonly migrator?: Migrator;

  readonly schemaPollMs?: number;
  readonly seeder: SeedsPhase;
  readonly tracer?: Tracer;

  /** See {@link DEFAULT_WAIT_MS}. */
  readonly waitMs?: number;
}

export interface BootstrapSummary {
  /**
   * What the data-migrations phase applied, in order, the ledger rows this
   * build does not know, and whether the caches were flushed after it. Absent
   * when the seeds did not run.
   */
  readonly dataMigrations: DataMigrationsSummary | undefined;

  /**
   * The unknown migrations applied by a run before the last run that applied
   * migrations this build knows, as the last read of the ledger found them:
   * the history was rewritten (#1148). A subset of {@link unknownMigrations}.
   */
  readonly divergedMigrations: readonly string[];

  /**
   * The credential that applied {@link migrationsApplied}: whether migrations
   * reached Postgres directly or through the connection pooler is in its host.
   * Absent when none were applied.
   */
  readonly migrationCredential?: MigrationCredential;

  readonly migrationsApplied: readonly string[];
  readonly phaseDurationsMs: Readonly<Record<string, number>>;

  /**
   * What the catalog reconcile wrote, by table, and whether the caches were
   * flushed after it. Absent when the seeds did not run.
   */
  readonly reconcile: ReconcileSummary | undefined;

  /** False for every process without a migrator, and for the api over a database that is ahead of it. */
  readonly seedsRun: boolean;

  /** What the first read of the ledger found. */
  readonly state: MigrationStateKind;

  readonly unknownMigrations: readonly string[];

  /**
   * Time from the start of the sequence until the read that found the schema up
   * had answered, time blocked on the lock included; 0 when the first read found
   * it up.
   */
  readonly waitedMs: number;
}

/**
 * A migration started and neither finished nor rolled back. Nothing safe can
 * run over it. The ledger cannot tell a crashed migration from one another
 * session is applying at this moment (a hand-run `migrate deploy` takes no
 * bootstrap lock), so the message says to rule that out before `resolve`.
 */
export class FailedMigrationError extends Error {
  constructor(readonly failed: readonly string[]) {
    super(
      `Refusing to boot: ${failed.length === 1 ? 'migration' : 'migrations'} ${failed.map((name) => `'${name}'`).join(', ')} ` +
        'started but did not finish. A `prisma migrate deploy` that is still running looks the same: if one is, ' +
        'let it finish and boot again. Otherwise inspect the database, then mark each one rolled back with ' +
        failed.map((name) => `\`prisma migrate resolve --rolled-back ${name}\``).join(' and ') +
        ' (or `--applied` if its statements did complete) and boot again. Prisma has no down migrations; fix forward.',
    );
    this.name = 'FailedMigrationError';
  }
}

/**
 * This build cannot apply migrations and nobody else did within the deadline.
 * A ledger that never appeared may also be one this process cannot see: a
 * schema its database role lacks USAGE on is skipped when Postgres looks the
 * table up, so a migrated ledger reads as absent.
 */
export class SchemaNotReadyError extends Error {
  constructor(
    readonly pending: readonly string[],
    readonly waitedMs: number,
    ledgerSeen = true,
  ) {
    super(
      `Refusing to boot: the schema is behind by ${pending.length} migration(s) (${pending.join(', ')}) and this process ` +
        `cannot apply migrations. Waited ${Math.round(waitedMs / 1000)}s for the migrating process (api) without it ` +
        'arriving. Start the api, or run `prisma migrate deploy` against this database, and boot again.' +
        (ledgerSeen
          ? ''
          : ` If the api reports this database migrated, the database role in ${DATABASE_URL_VARIABLE} may lack USAGE ` +
            'on the schema, which hides the ledger from it.'),
    );
    this.name = 'SchemaNotReadyError';
  }
}

/**
 * The migrator returned without applying everything the ledger said was
 * pending. With a migration credential of its own, Prisma's output can show a
 * clean run: the migrations reached another database, or the database role
 * that reads the ledger cannot see the schema they went to.
 */
export class MigrationsStillPendingError extends Error {
  constructor(
    readonly pending: readonly string[],
    readonly migrationCredential?: MigrationCredential,
  ) {
    super(
      `Refusing to boot: the migrator ran but ${pending.length} migration(s) are still pending (${pending.join(', ')}). ` +
        (migrationCredential?.variable === MIGRATION_URL_VARIABLE
          ? `If its output above shows them applied, either ${MIGRATION_URL_VARIABLE} and ${DATABASE_URL_VARIABLE} ` +
            'name different databases or schemas, so the migrations went to one and this process reads the other, ' +
            `or the database role in ${DATABASE_URL_VARIABLE} lacks USAGE on the schema, which hides the ledger from it. ` +
            'A half-migrated schema is not seeded.'
          : 'Read its output above; a half-migrated schema is not seeded.'),
    );
    this.name = 'MigrationsStillPendingError';
  }
}

/**
 * The boot sequence as decided from the database's state, under the lock
 * (#236). Ports in, summary out; nothing here knows Postgres, Prisma
 * or Nest, so every row of the behaviour table is a unit test.
 */
export async function runBootstrapSequence(options: BootstrapSequenceOptions): Promise<BootstrapSummary> {
  const { expected, ledger, lock, seeder, dataMigrations: dataMigrationsPhase, logger, migrator } = options;
  const clock = options.clock ?? systemClock;
  const tracer = options.tracer ?? trace.getTracer('@bge/bootstrap');
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const schemaPollMs = options.schemaPollMs ?? DEFAULT_SCHEMA_POLL_MS;

  const phaseDurationsMs: Record<string, number> = {};
  const phase = <T>(name: string, run: () => Promise<T>): Promise<T> =>
    tracer.startActiveSpan(`bootstrap.${name}`, async (span: Span) => {
      const started = clock.now();
      try {
        return await run();
      } catch (error) {
        failSpan(span, error);
        throw error;
      } finally {
        phaseDurationsMs[name] = (phaseDurationsMs[name] ?? 0) + (clock.now() - started);
        span.end();
      }
    });

  const readState = async (): Promise<MigrationState> => classifyMigrationState(expected, await ledger.readApplied());

  return tracer.startActiveSpan('bootstrap', async (root: Span) => {
    // One deadline for the whole sequence. The first acquire, every re-acquire
    // and the sleeps between polls all spend from it, so a boot is bounded by
    // `waitMs` however the time splits between the lock and the schema.
    const started = clock.now();
    const deadlineAt = started + waitMs;

    let firstState: MigrationStateKind | undefined;
    // What the ledger showed on the read the loop below settles on: `in-sync`,
    // `ahead` or `diverged`, and the migrations this build does not know.
    let settledState: MigrationStateKind;
    let unknownMigrations: readonly string[];
    let divergedMigrations: readonly string[];

    // Called once, on the read the boot settles on: a read while the schema is
    // behind classifies the unknown migrations before the pending ones apply,
    // and those can turn one that came in the last run into one before it, a
    // rewritten history rather than a rollback (#1148).
    const warnAboutUnknown = (state: MigrationState): void => {
      const rewritten = new Set(state.diverged);
      const newer = state.unknown.filter((name) => !rewritten.has(name));
      if (newer.length > 0) {
        logger.warn(
          `The database holds ${newer.length} migration(s) this build does not know (${newer.join(', ')}). ` +
            'Booting anyway: this is a rollback, or a newer build migrated first. Forward-only migrations must stay compatible with the previous build.',
        );
      }

      if (state.diverged.length > 0) {
        logger.warn(
          `The database holds ${state.diverged.length} migration(s) this build does not know, applied before a later ` +
            `run of migrations it does know (${state.diverged.join(', ')}): the migration history was rewritten. ` +
            `${divergedFixLines(state.diverged).join(' ')} ${divergedOutcome(state)}`,
        );
      }
    };

    // What the boot does next, said where the fix is: deleting a diverged row
    // does not run the seeds while a newer migration is also present.
    const divergedOutcome = (state: MigrationState): string => {
      if (!migrator) {
        return 'Booting anyway.';
      }

      if (state.kind === 'diverged') {
        return 'Running the seeds and the data migrations, as over a database in sync.';
      }

      return (
        'Booting anyway, with the seeds and the data migrations skipped while the database is also ahead of this ' +
        'build; deleting these rows does not change that.'
      );
    };

    // The warning that would have come after migrating, when migrating fails
    // instead: a pending migration that repeats a renamed one's changes fails
    // on them, and the row left under the old name is the explanation (#1148).
    // No DELETE here: while the pending migration stays failed, deleting the
    // old row recovers nothing, and the failure may have another cause.
    const warnAboutUnknownAfterFailedMigrate = (state: MigrationState): void => {
      if (state.unknown.length === 0) {
        return;
      }

      logger.warn(
        `Applying this build's migrations failed over a database holding ${state.unknown.length} migration(s) it ` +
          `does not know (${state.unknown.join(', ')}). A migration renamed or deleted after the database applied ` +
          'it leaves its row behind, and a pending migration repeating its changes fails on them. ' +
          'Resolve the failed migration first: the next boot names it and how to mark it. If one of these was ' +
          "renamed or deleted, then, once this build's migrations hold its changes, delete its row from " +
          `_prisma_migrations. ${DEVELOPMENT_DATABASE_RESET_LINE}`,
      );
    };

    let migrationsApplied: readonly string[] = [];
    let seedsRun = false;
    let reconcile: ReconcileSummary | undefined;
    let dataMigrations: DataMigrationsSummary | undefined;
    let waiting = false;
    let waitedMs = 0;

    let held = false;

    try {
      await phase('lock', () => lock.acquire({ deadlineAt }));
      held = true;

      for (;;) {
        const state = await phase('schema.read', readState);
        firstState ??= state.kind;
        unknownMigrations = state.unknown;
        divergedMigrations = state.diverged;

        if (state.kind === 'failed') {
          throw new FailedMigrationError(state.failed);
        }

        if (state.kind !== 'behind') {
          warnAboutUnknown(state);
          settledState = state.kind;
          // The wait ends with the read that found the schema up, not when the lock came back.
          if (waiting) {
            waitedMs = clock.now() - started;
          }

          break;
        }

        if (migrator) {
          logger.log(
            `Schema is behind by ${state.pending.length} migration(s): ${state.pending.join(', ')}. Applying.`,
          );
          // The ledger is read on a connection of its own, so the read can succeed
          // while the lock's connection fails beside it.
          lock.assertHeld();
          let after: MigrationState;
          try {
            await phase('schema.migrate', () => migrator.apply(state.pending));

            after = await phase('schema.read', readState);
            if (after.kind === 'failed') {
              throw new FailedMigrationError(after.failed);
            }

            if (after.pending.length > 0) {
              throw new MigrationsStillPendingError(after.pending, options.migrationCredential);
            }
          } catch (error) {
            warnAboutUnknownAfterFailedMigrate(state);
            throw error;
          }

          unknownMigrations = after.unknown;
          divergedMigrations = after.diverged;
          warnAboutUnknown(after);

          migrationsApplied = state.pending;
          settledState = after.kind;
          break;
        }

        // The clock decides, not a count of sleeps, and it counts from the same
        // start as the deadline: time blocked on the lock, the first time and on
        // every re-acquire, was spent waiting for the migrating process too.
        waiting = true;
        waitedMs = clock.now() - started;

        if (clock.now() >= deadlineAt) {
          throw new SchemaNotReadyError(state.pending, waitedMs, state.pending.length < expected.length);
        }

        logger.log(
          `Schema is behind by ${state.pending.length} migration(s) and this process cannot apply migrations; ` +
            `waiting for the migrating process (${Math.round(waitedMs / 1000)}s waited, ` +
            `${Math.round((deadlineAt - clock.now()) / 1000)}s left).`,
        );

        // Not held across the wait: the migrator needs it to do the work we are waiting for.
        await lock.release();
        held = false;
        // Cut to what is left, so the boot fails at the deadline and not up to a
        // poll after it; never negative, should the release itself have outlived it.
        await phase('schema.wait', () => clock.sleep(Math.max(0, Math.min(schemaPollMs, deadlineAt - clock.now()))));
        await phase('lock', () => lock.acquire({ deadlineAt }));
        held = true;
      }

      // Only the single writer runs the DML phases; an observer checks the schema and goes.
      if (migrator) {
        // Not over a database that is ahead, either: the seeds include the catalog
        // reconcile, and this build's manifest would retire the permissions and
        // revoke the grants a newer build added; its data migrations would shape
        // data the newer build already shaped. That data belongs to the build
        // that knows those migrations. A diverged database seeds: a run before
        // the last one applied each of its unknown migrations, so this build's
        // lineage owns the data and nothing newer is serving (#1148).
        if (settledState === 'ahead') {
          logger.log(
            'Seeds and data migrations skipped: the database is ahead of this build, so the newer build owns the data.',
          );
        } else {
          // Each write phase only under a lock still held, as the migrations
          // above: one lost while migrating or seeding may already be another boot's.
          lock.assertHeld();
          reconcile = await phase('seeds', () => seeder.run());
          seedsRun = true;
          lock.assertHeld();
          dataMigrations = await phase('data-migrations', () => dataMigrationsPhase.run());
        }
      }

      // Handing the lock back is the sequence's last step, so a release that
      // fails after a clean run is the boot's error like any other.
      held = false;
      await lock.release();
    } catch (error) {
      failSpan(root, error);
      // A release that fails after the sequence has already failed is logged and
      // recorded, not thrown: the first error is the one naming what the operator
      // must look at.
      if (held) {
        try {
          await lock.release();
        } catch (releaseError) {
          logger.warn(
            `The bootstrap lock could not be released after the sequence failed: ${messageOf(releaseError)}. ` +
              'It ends with its connection, at the latest when this process exits.',
          );
          root.recordException(releaseError instanceof Error ? releaseError : messageOf(releaseError));
        }
      }

      throw error;
    } finally {
      root.end();
    }

    return {
      state: firstState ?? 'in-sync',
      migrationsApplied,
      ...(migrationsApplied.length > 0 && options.migrationCredential
        ? { migrationCredential: options.migrationCredential }
        : {}),
      unknownMigrations,
      divergedMigrations,
      seedsRun,
      reconcile,
      dataMigrations,
      waitedMs,
      phaseDurationsMs,
    };
  });
}

/** A refused boot is an error on its span, not an unset status beside a stack trace in the log. */
function failSpan(span: Span, error: unknown): void {
  span.recordException(error instanceof Error ? error : messageOf(error));
  span.setStatus({ code: SpanStatusCode.ERROR, message: messageOf(error) });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
