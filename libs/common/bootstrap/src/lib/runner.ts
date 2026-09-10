import { classifyMigrationState, type MigrationState, type MigrationStateKind } from '@bge/database';
import { SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api';
import {
  DEFAULT_WAIT_MS,
  systemClock,
  type BootstrapLock,
  type BootstrapLogger,
  type Clock,
  type Migrator,
  type SchemaLedger,
  type SeedsPhase,
} from './ports';

/** How often a waiting process re-reads the ledger. */
export const DEFAULT_SCHEMA_POLL_MS = 5_000;

export interface BootstrapSequenceOptions {
  /** The migrations this build was generated from, in apply order. */
  readonly expected: readonly string[];
  readonly ledger: SchemaLedger;
  readonly lock: BootstrapLock;
  readonly seeder: SeedsPhase;
  readonly logger: BootstrapLogger;
  /** Present only in the api build. See {@link Migrator}. */
  readonly migrator?: Migrator;
  readonly clock?: Clock;
  readonly tracer?: Tracer;
  /** See {@link DEFAULT_WAIT_MS}. */
  readonly waitMs?: number;
  readonly schemaPollMs?: number;
}

export interface BootstrapSummary {
  /** What the first read of the ledger found. */
  readonly state: MigrationStateKind;
  readonly migrationsApplied: readonly string[];
  readonly unknownMigrations: readonly string[];
  /** False for every process without a migrator, and for the api over a database that is ahead of it. */
  readonly seedsRun: boolean;
  /** Time spent waiting for another process to bring the schema up. */
  readonly waitedMs: number;
  readonly phaseDurationsMs: Readonly<Record<string, number>>;
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

/** This build cannot apply migrations and nobody else did within the deadline. */
export class SchemaNotReadyError extends Error {
  constructor(
    readonly pending: readonly string[],
    readonly waitedMs: number,
  ) {
    super(
      `Refusing to boot: the schema is behind by ${pending.length} migration(s) (${pending.join(', ')}) and this process ` +
        `cannot apply migrations. Waited ${Math.round(waitedMs / 1000)}s for the migrating process (api) without it ` +
        'arriving. Start the api, or run `prisma migrate deploy` against this database, and boot again.',
    );
    this.name = 'SchemaNotReadyError';
  }
}

/** The migrator returned without applying everything the ledger said was pending. */
export class MigrationsStillPendingError extends Error {
  constructor(readonly pending: readonly string[]) {
    super(
      `Refusing to boot: the migrator ran but ${pending.length} migration(s) are still pending (${pending.join(', ')}). ` +
        'Read its output above; a half-migrated schema is not seeded.',
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
  const { expected, ledger, lock, seeder, logger, migrator } = options;
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
    const deadlineAt = clock.now() + waitMs;

    let firstState: MigrationStateKind | undefined;
    // What the ledger showed when the loop settled: `in-sync` or `ahead`.
    let settledState: MigrationStateKind = 'in-sync';
    let unknownMigrations: readonly string[] = [];
    let warnedUnknown: string | undefined;
    let migrationsApplied: readonly string[] = [];
    let seedsRun = false;
    let waitingSince: number | undefined;
    let waitedMs = 0;

    let held = false;

    try {
      await phase('lock', () => lock.acquire({ deadlineAt }));
      held = true;

      for (;;) {
        const state = await phase('schema.read', readState);
        firstState ??= state.kind;
        unknownMigrations = state.unknown;

        if (state.kind === 'failed') {
          throw new FailedMigrationError(state.failed);
        }

        // Once per distinct set: a waiting process re-reads every poll and
        // would otherwise bury its own progress line under copies of this.
        const unknownKey = state.unknown.join(',');
        if (state.unknown.length > 0 && warnedUnknown !== unknownKey) {
          warnedUnknown = unknownKey;
          logger.warn(
            `The database holds ${state.unknown.length} migration(s) this build does not know (${state.unknown.join(', ')}). ` +
              'Booting anyway: this is a rollback, or a newer build migrated first. Forward-only migrations must stay compatible with the previous build.',
          );
        }

        if (state.kind !== 'behind') {
          settledState = state.kind;
          break;
        }

        if (migrator) {
          logger.log(
            `Schema is behind by ${state.pending.length} migration(s): ${state.pending.join(', ')}. Applying.`,
          );
          await phase('schema.migrate', () => migrator.apply(state.pending));

          const after = await phase('schema.read', readState);
          if (after.kind === 'failed') throw new FailedMigrationError(after.failed);
          if (after.pending.length > 0) throw new MigrationsStillPendingError(after.pending);

          migrationsApplied = state.pending;
          settledState = after.kind;
          break;
        }

        // The clock decides, not a count of sleeps: time blocked on a
        // re-acquire counts the same as time asleep.
        waitingSince ??= clock.now();
        waitedMs = clock.now() - waitingSince;

        if (clock.now() >= deadlineAt) {
          throw new SchemaNotReadyError(state.pending, waitedMs);
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
        waitedMs = clock.now() - waitingSince;
      }

      // Only the single writer runs the DML phases; an observer checks the schema and goes.
      if (migrator) {
        // Not over a database that is ahead, either: the seeds include the catalog
        // reconcile, and this build's manifest would retire the permissions and
        // revoke the grants a newer build added. That data belongs to the build
        // that knows those migrations.
        if (settledState === 'ahead') {
          logger.log('Seeds skipped: the database is ahead of this build, so the newer build owns the reference data.');
        } else {
          await phase('seeds', () => seeder.run());
          seedsRun = true;
        }
      }
    } catch (error) {
      failSpan(root, error);
      throw error;
    } finally {
      if (held) {
        await lock.release();
      }
      root.end();
    }

    return {
      state: firstState ?? 'in-sync',
      migrationsApplied,
      unknownMigrations,
      seedsRun,
      waitedMs,
      phaseDurationsMs,
    };
  });
}

/** A refused boot is an error on its span, not an unset status beside a stack trace in the log. */
function failSpan(span: Span, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  span.recordException(error instanceof Error ? error : message);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}
