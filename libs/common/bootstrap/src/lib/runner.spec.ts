import type { AppliedMigrationRow } from '@bge/database';
import { SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import type {
  BootstrapLock,
  BootstrapLogger,
  Clock,
  LockAcquireOptions,
  Migrator,
  SchemaLedger,
  SeedsPhase,
} from './ports';
import { FailedMigrationError, MigrationsStillPendingError, runBootstrapSequence, SchemaNotReadyError } from './runner';

// The behaviour table locked on #236, one row per test, over fake ports.
// The real ports (a pg advisory lock, `_prisma_migrations`, the Prisma CLI,
// `runSeeds`) are exercised against Postgres in apps/api-e2e.

const CHAIN = ['20260109_init', '20260219_games', '20260301_permissions'];
const at = new Date('2026-09-01T00:00:00Z');
const finished = (name: string): AppliedMigrationRow => ({
  migration_name: name,
  finished_at: at,
  rolled_back_at: null,
});
const unfinished = (name: string): AppliedMigrationRow => ({
  migration_name: name,
  finished_at: null,
  rolled_back_at: null,
});

/** A ledger whose contents the test mutates between reads. */
class FakeLedger implements SchemaLedger {
  reads = 0;
  constructor(public rows: AppliedMigrationRow[]) {}
  async readApplied(): Promise<AppliedMigrationRow[]> {
    this.reads += 1;
    return [...this.rows];
  }
}

class FakeLock implements BootstrapLock {
  events: string[] = [];
  acquireOptions: (LockAcquireOptions | undefined)[] = [];
  /** Simulates time spent blocked on the lock, per acquire call. */
  blockedFor: number[] = [];
  /** Simulates a slow release round-trip, per release call. */
  releaseBlockedFor: number[] = [];
  /** When set, every release rejects with it: the dedicated connection dropped. */
  releaseError: Error | undefined;
  constructor(private readonly clock?: FakeClock) {}
  async acquire(options?: LockAcquireOptions): Promise<void> {
    this.events.push('acquire');
    this.acquireOptions.push(options);
    const blocked = this.blockedFor.shift();
    if (blocked && this.clock) this.clock.time += blocked;
  }
  async release(): Promise<void> {
    this.events.push('release');
    const blocked = this.releaseBlockedFor.shift();
    if (blocked && this.clock) this.clock.time += blocked;
    if (this.releaseError) throw this.releaseError;
  }
}

class FakeMigrator implements Migrator {
  calls: (readonly string[])[] = [];
  constructor(private readonly ledger: FakeLedger) {}
  async apply(pending: readonly string[]): Promise<void> {
    this.calls.push(pending);
    this.ledger.rows.push(...pending.map(finished));
  }
}

class FakeSeeder implements SeedsPhase {
  runs = 0;
  async run(): Promise<void> {
    this.runs += 1;
  }
}

class FakeClock implements Clock {
  time = 0;
  slept: number[] = [];
  now(): number {
    return this.time;
  }
  async sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    this.time += ms;
  }
}

function recordingLogger(): BootstrapLogger & { lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (message: string) => void lines.push(`${level}: ${message}`);
  return { lines, log: push('log'), warn: push('warn') };
}

describe('the boot sequence', () => {
  let logger: ReturnType<typeof recordingLogger>;
  let lock: FakeLock;
  let seeder: FakeSeeder;
  let clock: FakeClock;

  beforeEach(() => {
    logger = recordingLogger();
    lock = new FakeLock();
    seeder = new FakeSeeder();
    clock = new FakeClock();
  });

  it('in sync: runs the seeds and reports nothing applied', async () => {
    const ledger = new FakeLedger(CHAIN.map(finished));

    const summary = await runBootstrapSequence({
      expected: CHAIN,
      ledger,
      lock,
      seeder,
      logger,
      clock,
      migrator: new FakeMigrator(ledger),
    });

    expect(summary.state).toBe('in-sync');
    expect(summary.migrationsApplied).toEqual([]);
    expect(seeder.runs).toBe(1);
    expect(lock.events).toEqual(['acquire', 'release']);
  });

  it('behind with a migrator: applies the pending migrations, then seeds', async () => {
    const ledger = new FakeLedger([finished('20260109_init')]);
    const migrator = new FakeMigrator(ledger);

    const summary = await runBootstrapSequence({ expected: CHAIN, ledger, lock, seeder, logger, clock, migrator });

    expect(migrator.calls).toEqual([['20260219_games', '20260301_permissions']]);
    expect(summary.state).toBe('behind');
    expect(summary.migrationsApplied).toEqual(['20260219_games', '20260301_permissions']);
    expect(seeder.runs).toBe(1);
  });

  it('behind with a migrator whose run left migrations pending: refuses rather than seeding a half-migrated schema', async () => {
    const ledger = new FakeLedger([finished('20260109_init')]);
    const migrator: Migrator = { apply: async () => undefined };

    await expect(
      runBootstrapSequence({ expected: CHAIN, ledger, lock, seeder, logger, clock, migrator }),
    ).rejects.toBeInstanceOf(MigrationsStillPendingError);
    expect(seeder.runs).toBe(0);
    expect(lock.events).toEqual(['acquire', 'release']);
  });

  it('behind without a migrator: releases the lock, waits, and proceeds once the schema arrives — without seeding', async () => {
    const ledger = new FakeLedger([finished('20260109_init')]);
    // Somebody else (api) finishes the chain while this process is waiting.
    const original = ledger.readApplied.bind(ledger);
    ledger.readApplied = async () => {
      const rows = await original();
      if (ledger.reads === 2) ledger.rows = CHAIN.map(finished);
      return rows;
    };

    const summary = await runBootstrapSequence({
      expected: CHAIN,
      ledger,
      lock,
      seeder,
      logger,
      clock,
      waitMs: 60_000,
      schemaPollMs: 5_000,
    });

    expect(summary.state).toBe('behind');
    expect(summary.migrationsApplied).toEqual([]);
    expect(summary.waitedMs).toBe(10_000);
    expect(seeder.runs).toBe(0);
    // The lock is not held across a wait, or the migrator could never take it.
    expect(lock.events).toEqual(['acquire', 'release', 'acquire', 'release', 'acquire', 'release']);
    expect(logger.lines.some((line) => line.startsWith('log: ') && /waiting/i.test(line))).toBe(true);
  });

  it('behind without a migrator: one deadline from the start of the sequence rides on the first acquire and every re-acquire, and time blocked on the lock counts as waiting', async () => {
    const ledger = new FakeLedger([finished('20260109_init')]);
    const blockingLock = new FakeLock(clock);
    // The second acquire blocks for 7s on the lock (api migrating).
    blockingLock.blockedFor = [0, 7_000];

    const run = runBootstrapSequence({
      expected: CHAIN,
      ledger,
      lock: blockingLock,
      seeder,
      logger,
      clock,
      waitMs: 12_000,
      schemaPollMs: 5_000,
    });

    // 5s asleep + 7s on the lock = 12s: the deadline is reached by lock time, not by sleeps alone.
    await expect(run).rejects.toBeInstanceOf(SchemaNotReadyError);
    await expect(run).rejects.toThrow(/Waited 12s/);
    expect(blockingLock.acquireOptions).toEqual([{ deadlineAt: 12_000 }, { deadlineAt: 12_000 }]);
  });

  it('behind without a migrator: time spent taking the lock the first time comes out of the same budget', async () => {
    const ledger = new FakeLedger([finished('20260109_init')]);
    const blockingLock = new FakeLock(clock);
    // 8s blocked on the first acquire leaves 4s of a 12s budget for the schema to arrive.
    blockingLock.blockedFor = [8_000];

    const run = runBootstrapSequence({
      expected: CHAIN,
      ledger,
      lock: blockingLock,
      seeder,
      logger,
      clock,
      waitMs: 12_000,
      schemaPollMs: 5_000,
    });

    await expect(run).rejects.toBeInstanceOf(SchemaNotReadyError);
    // The one poll after the 8s already spent is cut to the 4s left: the boot
    // fails at 12s exactly, not 13s, and never after a second full budget.
    expect(clock.slept).toEqual([4_000]);
    expect(clock.now()).toBe(12_000);
    expect(blockingLock.acquireOptions).toEqual([{ deadlineAt: 12_000 }, { deadlineAt: 12_000 }]);
  });

  it('behind without a migrator and holding unknown migrations: warns about them once, not on every poll', async () => {
    const ledger = new FakeLedger([finished('20260109_init'), finished('20260910_from_the_future')]);
    const original = ledger.readApplied.bind(ledger);
    ledger.readApplied = async () => {
      const rows = await original();
      if (ledger.reads === 3) ledger.rows = [...CHAIN.map(finished), finished('20260910_from_the_future')];
      return rows;
    };

    const summary = await runBootstrapSequence({
      expected: CHAIN,
      ledger,
      lock,
      seeder,
      logger,
      clock,
      waitMs: 60_000,
      schemaPollMs: 5_000,
    });

    expect(summary.state).toBe('behind');
    expect(summary.unknownMigrations).toEqual(['20260910_from_the_future']);
    expect(ledger.reads).toBe(4);
    expect(logger.lines.filter((line) => line.startsWith('warn: '))).toHaveLength(1);
  });

  it('behind without a migrator, past the deadline: fails boot naming the pending migrations', async () => {
    const ledger = new FakeLedger([finished('20260109_init')]);

    const run = runBootstrapSequence({
      expected: CHAIN,
      ledger,
      lock,
      seeder,
      logger,
      clock,
      waitMs: 12_000,
      schemaPollMs: 5_000,
    });

    await expect(run).rejects.toBeInstanceOf(SchemaNotReadyError);
    await expect(run).rejects.toThrow(/20260219_games/);
    expect(lock.events[lock.events.length - 1]).toBe('release');
  });

  it('behind without a migrator: a release that outlives the deadline never turns into a negative sleep', async () => {
    const ledger = new FakeLedger([finished('20260109_init')]);
    const slowLock = new FakeLock(clock);
    // The deadline is checked, then the release round-trip alone takes 11s of a 10s budget.
    slowLock.releaseBlockedFor = [11_000];

    const run = runBootstrapSequence({
      expected: CHAIN,
      ledger,
      lock: slowLock,
      seeder,
      logger,
      clock,
      waitMs: 10_000,
      schemaPollMs: 5_000,
    });

    await expect(run).rejects.toBeInstanceOf(SchemaNotReadyError);
    // Not `-1_000`: a fake clock would run backwards, and a real one would poll at once, but silently.
    expect(clock.slept).toEqual([0]);
  });

  it('failed: refuses boot, names the migration and the resolve command, and never calls the migrator', async () => {
    const ledger = new FakeLedger([finished('20260109_init'), unfinished('20260219_games')]);
    const migrator = new FakeMigrator(ledger);

    const run = runBootstrapSequence({ expected: CHAIN, ledger, lock, seeder, logger, clock, migrator });

    await expect(run).rejects.toBeInstanceOf(FailedMigrationError);
    await expect(run).rejects.toThrow(/prisma migrate resolve --rolled-back 20260219_games/);
    // A `migrate deploy` in progress leaves the same row; the advice says so before naming `resolve`.
    await expect(run).rejects.toThrow(/still running looks the same/);
    expect(migrator.calls).toEqual([]);
    expect(seeder.runs).toBe(0);
  });

  it('ahead: warns about the unknown migrations and boots, leaving the seeds to the build that knows them', async () => {
    const ledger = new FakeLedger([...CHAIN.map(finished), finished('20260910_from_the_future')]);

    const summary = await runBootstrapSequence({
      expected: CHAIN,
      ledger,
      lock,
      seeder,
      logger,
      clock,
      migrator: new FakeMigrator(ledger),
    });

    expect(summary.state).toBe('ahead');
    expect(summary.unknownMigrations).toEqual(['20260910_from_the_future']);
    // This build's catalog reconcile would retire what the newer build added.
    expect(seeder.runs).toBe(0);
    expect(summary.seedsRun).toBe(false);
    expect(logger.lines.some((line) => line.startsWith('warn: ') && line.includes('20260910_from_the_future'))).toBe(
      true,
    );
    expect(logger.lines.some((line) => line.startsWith('log: ') && /seeds.*skipped/i.test(line))).toBe(true);
  });

  it('behind with a migrator, the database also holding an unknown migration: applies, then still leaves the seeds alone', async () => {
    const ledger = new FakeLedger([finished('20260109_init'), finished('20260910_from_the_future')]);
    const migrator = new FakeMigrator(ledger);

    const summary = await runBootstrapSequence({ expected: CHAIN, ledger, lock, seeder, logger, clock, migrator });

    expect(summary.state).toBe('behind');
    expect(summary.migrationsApplied).toEqual(['20260219_games', '20260301_permissions']);
    expect(summary.unknownMigrations).toEqual(['20260910_from_the_future']);
    expect(seeder.runs).toBe(0);
    expect(summary.seedsRun).toBe(false);
  });

  it('ends every span, the root included, when the lock itself cannot be acquired', async () => {
    const ended: string[] = [];
    const tracer = {
      startActiveSpan: (name: string, run: (span: Span) => unknown) =>
        run({
          end: () => void ended.push(name),
          setStatus: () => undefined,
          recordException: () => undefined,
        } as unknown as Span),
    } as unknown as Tracer;
    const refusing: BootstrapLock = {
      acquire: async () => {
        throw new Error('lock held by a dead session');
      },
      release: async () => void lock.events.push('release'),
    };

    await expect(
      runBootstrapSequence({
        expected: CHAIN,
        ledger: new FakeLedger(CHAIN.map(finished)),
        lock: refusing,
        seeder,
        logger,
        clock,
        tracer,
      }),
    ).rejects.toThrow('lock held by a dead session');

    expect(ended).toEqual(['bootstrap.lock', 'bootstrap']);
    // Never acquired, so never released.
    expect(lock.events).toEqual([]);
  });

  it('marks the failing phase and the root span as errors, so a refused boot shows in the trace', async () => {
    const statuses: Record<string, number> = {};
    const exceptions: string[] = [];
    const tracer = {
      startActiveSpan: (name: string, run: (span: Span) => unknown) =>
        run({
          end: () => undefined,
          setStatus: ({ code }: { code: number }) => void (statuses[name] = code),
          recordException: (error: Error) => void exceptions.push(`${name}: ${error.message}`),
        } as unknown as Span),
    } as unknown as Tracer;
    const refusing: BootstrapLock = {
      acquire: async () => {
        throw new Error('lock held by a dead session');
      },
      release: async () => undefined,
    };

    await expect(
      runBootstrapSequence({
        expected: CHAIN,
        ledger: new FakeLedger(CHAIN.map(finished)),
        lock: refusing,
        seeder,
        logger,
        clock,
        tracer,
      }),
    ).rejects.toThrow('lock held by a dead session');

    expect(statuses).toEqual({ 'bootstrap.lock': SpanStatusCode.ERROR, bootstrap: SpanStatusCode.ERROR });
    expect(exceptions).toEqual([
      'bootstrap.lock: lock held by a dead session',
      'bootstrap: lock held by a dead session',
    ]);
  });

  it('releases the lock when a phase throws', async () => {
    const ledger = new FakeLedger(CHAIN.map(finished));
    const failing: SeedsPhase = {
      run: async () => {
        throw new Error('seed exploded');
      },
    };

    await expect(
      runBootstrapSequence({
        expected: CHAIN,
        ledger,
        lock,
        seeder: failing,
        logger,
        clock,
        migrator: new FakeMigrator(ledger),
      }),
    ).rejects.toThrow('seed exploded');
    expect(lock.events).toEqual(['acquire', 'release']);
  });

  describe('when the lock cannot be released', () => {
    /** A tracer that records what each span was told, so the trace of a failed release can be asserted. */
    function recordingTracer() {
      const ended: string[] = [];
      const statuses: Record<string, number> = {};
      const exceptions: string[] = [];
      const tracer = {
        startActiveSpan: (name: string, run: (span: Span) => unknown) =>
          run({
            end: () => void ended.push(name),
            setStatus: ({ code }: { code: number }) => void (statuses[name] = code),
            recordException: (error: Error) => void exceptions.push(`${name}: ${error.message}`),
          } as unknown as Span),
      } as unknown as Tracer;
      return { tracer, ended, statuses, exceptions };
    }

    it('after a refused boot: the refusal stays the error, the release failure is logged and on the root span, and the root span still ends', async () => {
      const ledger = new FakeLedger([finished('20260109_init'), unfinished('20260219_games')]);
      lock.releaseError = new Error('connection terminated unexpectedly');
      const { tracer, ended, exceptions } = recordingTracer();

      const run = runBootstrapSequence({ expected: CHAIN, ledger, lock, seeder, logger, clock, tracer });

      // Not the release error: that would hide the migration the operator has to look at.
      await expect(run).rejects.toBeInstanceOf(FailedMigrationError);
      expect(ended).toContain('bootstrap');
      expect(exceptions).toContain('bootstrap: connection terminated unexpectedly');
      expect(logger.lines.some((line) => line.startsWith('warn: ') && /release/i.test(line))).toBe(true);
    });

    it('after a completed sequence: the release failure fails the boot, marked on the root span, which still ends', async () => {
      const ledger = new FakeLedger(CHAIN.map(finished));
      lock.releaseError = new Error('connection terminated unexpectedly');
      const { tracer, ended, statuses } = recordingTracer();

      const run = runBootstrapSequence({
        expected: CHAIN,
        ledger,
        lock,
        seeder,
        logger,
        clock,
        tracer,
        migrator: new FakeMigrator(ledger),
      });

      await expect(run).rejects.toThrow('connection terminated unexpectedly');
      // The seeds did run; what failed is handing the lock back.
      expect(seeder.runs).toBe(1);
      expect(ended).toEqual(['bootstrap.lock', 'bootstrap.schema.read', 'bootstrap.seeds', 'bootstrap']);
      expect(statuses).toEqual({ bootstrap: SpanStatusCode.ERROR });
    });
  });
});
