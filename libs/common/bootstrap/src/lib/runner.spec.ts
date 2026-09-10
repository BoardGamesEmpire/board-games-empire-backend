import type { AppliedMigrationRow } from '@bge/database';
import type { Span, Tracer } from '@opentelemetry/api';
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
  constructor(private readonly clock?: FakeClock) {}
  async acquire(options?: LockAcquireOptions): Promise<void> {
    this.events.push('acquire');
    this.acquireOptions.push(options);
    const blocked = this.blockedFor.shift();
    if (blocked && this.clock) this.clock.time += blocked;
  }
  async release(): Promise<void> {
    this.events.push('release');
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
    // One 5s poll after the 8s already spent: the boot fails at 13s, not after a second full budget.
    expect(clock.now()).toBe(13_000);
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

  it('failed: refuses boot, names the migration and the resolve command, and never calls the migrator', async () => {
    const ledger = new FakeLedger([finished('20260109_init'), unfinished('20260219_games')]);
    const migrator = new FakeMigrator(ledger);

    const run = runBootstrapSequence({ expected: CHAIN, ledger, lock, seeder, logger, clock, migrator });

    await expect(run).rejects.toBeInstanceOf(FailedMigrationError);
    await expect(run).rejects.toThrow(/prisma migrate resolve --rolled-back 20260219_games/);
    expect(migrator.calls).toEqual([]);
    expect(seeder.runs).toBe(0);
  });

  it('ahead: warns about the unknown migrations and boots', async () => {
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
    expect(seeder.runs).toBe(1);
    expect(logger.lines.some((line) => line.startsWith('warn: ') && line.includes('20260910_from_the_future'))).toBe(
      true,
    );
  });

  it('ends every span, the root included, when the lock itself cannot be acquired', async () => {
    const ended: string[] = [];
    const tracer = {
      startActiveSpan: (name: string, run: (span: Span) => unknown) =>
        run({ end: () => void ended.push(name) } as unknown as Span),
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
});
