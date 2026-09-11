import {
  BOOTSTRAP_LOCK_NAME,
  createPrismaCliMigrator,
  FailedMigrationError,
  LockNotAcquiredError,
  PgAdvisoryLock,
  PrismaSchemaLedger,
  RegistryDataMigrations,
  runBootstrapSequence,
  RunSeedsSeeder,
  SchemaNotReadyError,
  systemClock,
  type BootstrapLogger,
  type DataMigrationsPhase,
  type Migrator,
  type ReconcileSummary,
  type SeedsPhase,
} from '@bge/bootstrap';
import {
  CATALOG_MANIFEST,
  DataMigrationRevisionError,
  MIGRATION_NAMES,
  readAppliedMigrations,
  type PrismaClient,
} from '@bge/database';
import type { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from 'pg';
import { schemaFromDatabaseUrl } from '../support/e2e-env';
import { expectAdvisoryWaiter, withBarrier } from '../support/lock-barrier';
import { createTestDatabase, requireDatabaseUrl, type TestDatabase } from '../support/test-db';

/**
 * The boot sequence against a real database (#236).
 *
 * The behaviour table is unit-tested over fake ports in `@bge/bootstrap`. What
 * only Postgres can show is the ports themselves: that the advisory lock makes
 * a second boot a genuine blocked waiter, that the Prisma CLI
 * migrator brings an empty database to the full chain exactly once under two
 * simultaneous boots, and that the state read over `_prisma_migrations`
 * classifies a failed, an unknown and a rolled-back row the way the runner
 * expects.
 *
 * DB-only, like `catalog-reconcile.spec.ts`: no HTTP. The harness database is
 * touched read-only here; everything that needs a database in a particular
 * state runs against a sandbox database created in the same Postgres and
 * dropped at the end.
 */

/** apps/api-e2e/src/bootstrap → workspace root; where prisma.config.ts is. */
const WORKSPACE_ROOT = path.join(__dirname, '..', '..', '..', '..');
const SANDBOX_DATABASE = 'bge_bootstrap_e2e';

const silent: BootstrapLogger = { log: () => undefined, warn: () => undefined };

function recordingLogger(): BootstrapLogger & { readonly lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (message: string) => void lines.push(`${level}: ${message}`);
  return { lines, log: push('log'), warn: push('warn') };
}

const NO_WRITES: ReconcileSummary = {
  permissionsCreated: 0,
  permissionsUpdated: 0,
  permissionsRevived: 0,
  permissionsRetired: 0,
  rolesCreated: 0,
  rolesUpdated: 0,
  grantsCreated: 0,
  grantsRevoked: 0,
  mutations: 0,
  cachesFlushed: false,
};

/** Records when each seeds pass ran; `inner` is the real seeds phase where the test wants it. */
class CountingSeeder implements SeedsPhase {
  readonly spans: [number, number][] = [];
  constructor(
    private readonly inner: () => Promise<ReconcileSummary> = async () => {
      await sleep(50);
      return NO_WRITES;
    },
  ) {}
  async run(): Promise<ReconcileSummary> {
    const started = Date.now();
    const outcome = await this.inner();
    this.spans.push([started, Date.now()]);
    return outcome;
  }
}

/** The seeds want a Nest `Logger`; they call `log`/`debug`/`error` only, so a silent stand-in is honest here. */
const silentSeedLogger = {
  log: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

const realSeeds = (client: PrismaClient) => () => new RunSeedsSeeder(client, { logger: silentSeedLogger }).run();
/** The shipped registry is empty; where the seeds are counted rather than run, the ledger phase is a no-op too. */
const noDataMigrations: DataMigrationsPhase = { run: async () => ({ applied: [], unknown: [], cachesFlushed: false }) };
const realDataMigrations = (client: PrismaClient) => new RegistryDataMigrations(client, { logger: silentSeedLogger });

class CountingMigrator implements Migrator {
  calls = 0;
  constructor(private readonly inner?: Migrator) {}
  async apply(pending: readonly string[]): Promise<void> {
    this.calls += 1;
    await this.inner?.apply(pending);
  }
}

function sandboxUrl(): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${SANDBOX_DATABASE}`;
  return url.toString();
}

function lockOn(connectionString: string, name: string, logger: BootstrapLogger = silent): PgAdvisoryLock {
  return new PgAdvisoryLock({
    connectionString,
    logger,
    applicationName: `bge-bootstrap:${name}`,
    attemptMs: 500,
    waitMs: 20_000,
  });
}

/**
 * Advisory locks on the bootstrap key held or awaited on `db`'s database, from
 * any backend: granted (held) or not (a blocked waiter). `pg_locks` is
 * cluster-wide, so the database filter is what keeps the harness database's
 * locks out of a sandbox count and vice versa.
 */
async function bootstrapLocks(db: TestDatabase, granted: boolean): Promise<number> {
  const rows = await db.client.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n
      FROM pg_locks
     WHERE locktype = 'advisory' AND granted = ${granted} AND objsubid = 1
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND classid = ((hashtextextended(${BOOTSTRAP_LOCK_NAME}::text, 0) >> 32) & 4294967295)::oid
       AND objid = (hashtextextended(${BOOTSTRAP_LOCK_NAME}::text, 0) & 4294967295)::oid`;
  return Number(rows[0]?.n ?? 0);
}

describe('the boot sequence against Postgres', () => {
  let db: TestDatabase;
  let admin: Client;

  beforeAll(async () => {
    db = createTestDatabase();
    admin = new Client({ connectionString: requireDatabaseUrl() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${SANDBOX_DATABASE}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${SANDBOX_DATABASE}"`);
  });

  afterAll(async () => {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS "${SANDBOX_DATABASE}" WITH (FORCE)`);
    await admin.end();
  });

  describe('on the harness database, already migrated and seeded', () => {
    it('finds it in sync, runs the seeds phase once, and leaves no lock behind', async () => {
      const seeder = new CountingSeeder();
      const migrator = new CountingMigrator();
      const lock = lockOn(requireDatabaseUrl(), 'in-sync');

      try {
        const summary = await runBootstrapSequence({
          expected: MIGRATION_NAMES,
          ledger: new PrismaSchemaLedger(db.client),
          lock,
          seeder,
          dataMigrations: noDataMigrations,
          migrator,
          logger: silent,
        });

        expect(summary.state).toBe('in-sync');
        expect(summary.migrationsApplied).toEqual([]);
        expect(migrator.calls).toBe(0);
        expect(seeder.spans).toHaveLength(1);
      } finally {
        await lock.close();
      }

      expect(await bootstrapLocks(db, true)).toBe(0);
    });

    it('refuses over a data migration whose revision changed after it ran, after the seeds, and leaves no lock behind', async () => {
      const name = '20260901000000_e2e_bootstrap_revision';
      await db.client.dataMigration.create({ data: { name, revision: 1, durationMs: 0 } });
      const seeder = new CountingSeeder();
      const lock = lockOn(requireDatabaseUrl(), 'revision-mismatch');
      const dataMigrations = new RegistryDataMigrations(db.client, {
        logger: silentSeedLogger,
        entries: [{ name, revision: 2, run: async () => undefined }],
      });

      try {
        await expect(
          runBootstrapSequence({
            expected: MIGRATION_NAMES,
            ledger: new PrismaSchemaLedger(db.client),
            lock,
            seeder,
            dataMigrations,
            migrator: new CountingMigrator(),
            logger: silent,
          }),
        ).rejects.toBeInstanceOf(DataMigrationRevisionError);
        // The refusal lands after the seeds phase, which is idempotent and had run.
        expect(seeder.spans).toHaveLength(1);
      } finally {
        await lock.close();
        await db.client.dataMigration.deleteMany({ where: { name } });
      }

      expect(await bootstrapLocks(db, true)).toBe(0);
    });

    it('queues a second boot behind the advisory lock as a real blocked waiter, names the holder, and proceeds once it is released', async () => {
      await withBarrier(async (barrier) => {
        await barrier.holder.query('SELECT pg_advisory_lock(hashtextextended($1::text, 0))', [BOOTSTRAP_LOCK_NAME]);

        const logger = recordingLogger();
        const lock = lockOn(requireDatabaseUrl(), 'second-boot', logger);
        let settled: string | undefined;
        const run = runBootstrapSequence({
          expected: MIGRATION_NAMES,
          ledger: new PrismaSchemaLedger(db.client),
          lock,
          seeder: new CountingSeeder(),
          dataMigrations: noDataMigrations,
          migrator: new CountingMigrator(),
          logger,
        });
        run.then(
          () => (settled = 'resolved'),
          (error: unknown) => (settled = `rejected: ${String(error)}`),
        );

        try {
          const waiter = await expectAdvisoryWaiter(barrier, {
            heldBy: barrier.holder.pid,
            description: 'the second boot',
            settledEarly: () => settled,
            timeoutMs: 5_000,
          });
          expect(waiter.query).toContain('pg_advisory_lock');

          // One attempt is 500ms here; the progress line names the holder after it.
          const deadline = Date.now() + 5_000;
          while (!logger.lines.some((line) => /Waiting for the bootstrap lock held by pid \d+/.test(line))) {
            if (Date.now() > deadline) throw new Error(`no progress line; lines were:\n${logger.lines.join('\n')}`);
            await sleep(25);
          }

          await barrier.holder.query('SELECT pg_advisory_unlock(hashtextextended($1::text, 0))', [BOOTSTRAP_LOCK_NAME]);

          const summary = await run;
          expect(summary.state).toBe('in-sync');
        } finally {
          await lock.close();
        }
      });
    });

    it('gives up at the shared deadline even when a single lock attempt is longer than the time left', async () => {
      await withBarrier(async (barrier) => {
        await barrier.holder.query('SELECT pg_advisory_lock(hashtextextended($1::text, 0))', [BOOTSTRAP_LOCK_NAME]);

        // A 5s attempt against a 300ms budget: the attempt must be cut to the
        // budget, or the boot runs almost a full attempt past its deadline.
        const lock = new PgAdvisoryLock({
          connectionString: requireDatabaseUrl(),
          logger: silent,
          applicationName: 'bge-bootstrap:short-deadline',
          attemptMs: 5_000,
        });
        const started = systemClock.now();

        try {
          await expect(lock.acquire({ deadlineAt: started + 300 })).rejects.toBeInstanceOf(LockNotAcquiredError);
          expect(systemClock.now() - started).toBeLessThan(2_000);
        } finally {
          await lock.close();
          await barrier.holder.query('SELECT pg_advisory_unlock(hashtextextended($1::text, 0))', [BOOTSTRAP_LOCK_NAME]);
        }
      });
    });
  });

  describe('on an empty sandbox database', () => {
    let sandbox: TestDatabase;
    let sandboxAdmin: Client;

    beforeAll(async () => {
      sandbox = createTestDatabase(sandboxUrl());
      sandboxAdmin = new Client({ connectionString: sandboxUrl() });
      await sandboxAdmin.connect();
      // A raw pg client ignores the URL's `?schema=`; the Prisma clients and
      // the CLI honour it, so this one is pointed at the same schema by hand.
      await sandboxAdmin.query('SELECT set_config($1, $2, false)', [
        'search_path',
        `${schemaFromDatabaseUrl(sandboxUrl())}, public`,
      ]);
    });

    afterAll(async () => {
      await sandbox.close();
      await sandboxAdmin.end();
    });

    it('two simultaneous api boots: one is witnessed blocked, the chain is applied exactly once, and the real seeds run one after the other', async () => {
      const real = createPrismaCliMigrator({ databaseUrl: sandboxUrl(), logger: silent, projectRoot: WORKSPACE_ROOT });
      const migrator = new CountingMigrator(real);
      const seeder = new CountingSeeder(realSeeds(sandbox.client));
      const locks = [lockOn(sandboxUrl(), 'boot-a'), lockOn(sandboxUrl(), 'boot-b')];

      try {
        const boots = Promise.all(
          locks.map((lock) =>
            runBootstrapSequence({
              expected: MIGRATION_NAMES,
              ledger: new PrismaSchemaLedger(sandbox.client),
              lock,
              seeder,
              dataMigrations: realDataMigrations(sandbox.client),
              migrator,
              logger: silent,
            }),
          ),
        );

        // While the winner migrates, the loser must be a real ungranted advisory
        // waiter on the key — not merely "not finished yet".
        const deadline = Date.now() + 10_000;
        while ((await bootstrapLocks(sandbox, false)) === 0) {
          if (Date.now() > deadline) throw new Error('the second boot never queued behind the bootstrap lock');
          await sleep(25);
        }

        const [a, b] = await boots;

        expect(migrator.calls).toBe(1);
        expect([a.state, b.state].sort()).toEqual(['behind', 'in-sync']);
        const winner = a.state === 'behind' ? a : b;
        expect(winner.migrationsApplied).toEqual([...MIGRATION_NAMES]);

        // Both are writers, so both run the seeds (idempotent); the lock keeps
        // the passes from overlapping, and the second finds nothing to write.
        expect(seeder.spans).toHaveLength(2);
        const [[, firstEnd], [secondStart]] = [...seeder.spans].sort((x, y) => x[0] - y[0]);
        expect(secondStart).toBeGreaterThanOrEqual(firstEnd);
      } finally {
        await Promise.all(locks.map((lock) => lock.close()));
      }

      const applied = await readAppliedMigrations(sandbox.client);
      expect(applied.filter((row) => row.finished_at !== null).map((row) => row.migration_name)).toEqual([
        ...MIGRATION_NAMES,
      ]);
      expect(await sandbox.client.permission.count()).toBe(CATALOG_MANIFEST.permissions.length);
      expect(await sandbox.client.gameLength.count()).toBeGreaterThan(0);
    });

    it('refuses to boot over a migration that started and never finished, naming it and the resolve command', async () => {
      const name = '20990101000000_never_finished';
      await sandboxAdmin.query(
        'INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count) VALUES ($1, $2, $3, now(), 0)',
        [randomUUID(), 'f'.repeat(64), name],
      );
      const migrator = new CountingMigrator();
      const lock = lockOn(sandboxUrl(), 'failed');

      try {
        const run = runBootstrapSequence({
          expected: MIGRATION_NAMES,
          ledger: new PrismaSchemaLedger(sandbox.client),
          lock,
          seeder: new CountingSeeder(),
          dataMigrations: noDataMigrations,
          migrator,
          logger: silent,
        });

        await expect(run).rejects.toBeInstanceOf(FailedMigrationError);
        await expect(run).rejects.toThrow(new RegExp(`prisma migrate resolve --rolled-back ${name}`));
        expect(migrator.calls).toBe(0);
      } finally {
        await lock.close();
        await sandboxAdmin.query('DELETE FROM _prisma_migrations WHERE migration_name = $1', [name]);
      }
    });

    it('warns about a finished migration this build does not know, and boots', async () => {
      const name = '20990101000000_from_a_newer_build';
      await sandboxAdmin.query(
        'INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count) VALUES ($1, $2, $3, now(), now(), 1)',
        [randomUUID(), 'a'.repeat(64), name],
      );
      const logger = recordingLogger();
      const seeder = new CountingSeeder();
      const lock = lockOn(sandboxUrl(), 'ahead', logger);

      try {
        const summary = await runBootstrapSequence({
          expected: MIGRATION_NAMES,
          ledger: new PrismaSchemaLedger(sandbox.client),
          lock,
          seeder,
          dataMigrations: noDataMigrations,
          migrator: new CountingMigrator(),
          logger,
        });

        expect(summary.state).toBe('ahead');
        expect(summary.unknownMigrations).toEqual([name]);
        expect(summary.seedsRun).toBe(false);
        expect(seeder.spans).toHaveLength(0);
        expect(logger.lines.some((line) => line.startsWith('warn: ') && line.includes(name))).toBe(true);
      } finally {
        await lock.close();
        await sandboxAdmin.query('DELETE FROM _prisma_migrations WHERE migration_name = $1', [name]);
      }
    });

    it('names only holders in its own database: the same key held in another database is not the blocker', async () => {
      // Advisory keys are per database, but `pg_locks` lists the whole cluster.
      const sandboxPid = (await sandboxAdmin.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await sandboxAdmin.query('SELECT pg_advisory_lock(hashtextextended($1::text, 0))', [BOOTSTRAP_LOCK_NAME]);

      try {
        await withBarrier(async (barrier) => {
          await barrier.holder.query('SELECT pg_advisory_lock(hashtextextended($1::text, 0))', [BOOTSTRAP_LOCK_NAME]);
          const logger = recordingLogger();
          const lock = lockOn(requireDatabaseUrl(), 'cross-database', logger);

          try {
            const run = lock.acquire({ deadlineAt: systemClock.now() + 1_200 });
            await expect(run).rejects.toBeInstanceOf(LockNotAcquiredError);
            await expect(run).rejects.toThrow(`pid ${barrier.holder.pid}`);
            await expect(run).rejects.not.toThrow(`pid ${sandboxPid}`);
            expect(logger.lines.filter((line) => line.includes(`pid ${sandboxPid}`))).toEqual([]);
          } finally {
            await lock.close();
            await barrier.holder.query('SELECT pg_advisory_unlock(hashtextextended($1::text, 0))', [
              BOOTSTRAP_LOCK_NAME,
            ]);
          }
        });
      } finally {
        await sandboxAdmin.query('SELECT pg_advisory_unlock(hashtextextended($1::text, 0))', [BOOTSTRAP_LOCK_NAME]);
      }
    });

    describe('a process without a migrator, behind by the last migration', () => {
      const last = MIGRATION_NAMES[MIGRATION_NAMES.length - 1];

      beforeEach(async () => {
        // A rolled-back row is how Prisma records "cleared for retry"; to the
        // classifier it is a pending migration, not a failed one.
        await sandboxAdmin.query(
          'UPDATE _prisma_migrations SET finished_at = NULL, rolled_back_at = now() WHERE migration_name = $1',
          [last],
        );
      });

      afterEach(async () => {
        await sandboxAdmin.query(
          'UPDATE _prisma_migrations SET finished_at = now(), rolled_back_at = NULL WHERE migration_name = $1',
          [last],
        );
      });

      it('waits without holding the lock, then boots once the schema arrives, without seeding', async () => {
        const logger = recordingLogger();
        const seeder = new CountingSeeder();
        const lock = lockOn(sandboxUrl(), 'observer', logger);

        try {
          const run = runBootstrapSequence({
            expected: MIGRATION_NAMES,
            ledger: new PrismaSchemaLedger(sandbox.client),
            lock,
            seeder,
            dataMigrations: noDataMigrations,
            logger,
            schemaPollMs: 200,
            waitMs: 15_000,
          });

          // While it waits, the lock must be free for the migrator to take.
          await sleep(300);
          expect(await bootstrapLocks(sandbox, true)).toBe(0);

          await sandboxAdmin.query(
            'UPDATE _prisma_migrations SET finished_at = now(), rolled_back_at = NULL WHERE migration_name = $1',
            [last],
          );

          const summary = await run;
          expect(summary.state).toBe('behind');
          expect(summary.migrationsApplied).toEqual([]);
          expect(summary.seedsRun).toBe(false);
          expect(summary.waitedMs).toBeGreaterThanOrEqual(200);
          expect(seeder.spans).toHaveLength(0);
          expect(logger.lines.some((line) => /waiting for the migrating process/.test(line))).toBe(true);
        } finally {
          await lock.close();
        }
      });

      it('fails its boot at the deadline, naming the pending migration', async () => {
        const lock = lockOn(sandboxUrl(), 'observer-deadline');

        try {
          const run = runBootstrapSequence({
            expected: MIGRATION_NAMES,
            ledger: new PrismaSchemaLedger(sandbox.client),
            lock,
            seeder: new CountingSeeder(),
            dataMigrations: noDataMigrations,
            logger: silent,
            schemaPollMs: 200,
            waitMs: 500,
          });

          await expect(run).rejects.toBeInstanceOf(SchemaNotReadyError);
          await expect(run).rejects.toThrow(last);
        } finally {
          await lock.close();
        }
      });
    });
  });
});
