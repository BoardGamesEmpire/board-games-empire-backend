import {
  BOOTSTRAP_LOCK_NAME,
  createPrismaCliMigrator,
  FailedMigrationError,
  LedgerAccessDeniedError,
  LockLostError,
  LockNotAcquiredError,
  MigrateDeployFailedError,
  PgAdvisoryLock,
  PrismaSchemaLedger,
  RegistryDataMigrations,
  runBootstrap,
  runBootstrapSequence,
  RunSeedsSeeder,
  SchemaNotReadyError,
  systemClock,
  type BootstrapLogger,
  type BootstrapSummary,
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
import type { Logger, LoggerService } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from 'pg';
import { schemaFromDatabaseUrl } from '../support/e2e-env';
import { expectAdvisoryWaiter, withBarrier } from '../support/lock-barrier';
import { startPgBouncer, type PgBouncer } from '../support/pgbouncer';
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

/** `connectionString` with a Postgres setting given at connect, as `ALTER ROLE ... SET` would give it. */
function withSetting(connectionString: string, name: string, value: string): string {
  const url = new URL(connectionString);
  url.searchParams.set('options', `-c ${name}=${value}`);
  return url.toString();
}

/** A relay to `connectionString`'s Postgres that holds every chunk `delayMs` in each direction. */
async function slowLink(connectionString: string, delayMs: number) {
  const target = new URL(connectionString);
  const sockets = new Set<Socket>();
  let connections = 0;
  const relay = (from: Socket, to: Socket) => {
    from.on('data', (chunk) => void setTimeout(() => to.writable && to.write(chunk), delayMs));
    from.on('close', () => void setTimeout(() => to.destroy(), delayMs));
    from.on('error', () => to.destroy());
  };
  const server = createServer((client) => {
    connections += 1;
    const database = connect(Number(target.port || 5432), target.hostname);
    sockets.add(client).add(database);
    relay(client, database);
    relay(database, client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const url = new URL(connectionString);
  url.hostname = '127.0.0.1';
  url.port = String((server.address() as AddressInfo).port);
  return {
    url: url.toString(),
    connections: () => connections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
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

    it("warns and boots over a data migration the ledger holds at a revision above this build's, a rollback, leaving the entry alone", async () => {
      const name = '20260901000000_e2e_bootstrap_rollback';
      await db.client.dataMigration.create({ data: { name, revision: 2, durationMs: 0 } });
      const warnings: string[] = [];
      const seedLogger = {
        log: () => undefined,
        debug: () => undefined,
        error: () => undefined,
        warn: (message: unknown) => void warnings.push(String(message)),
      } as unknown as Logger;
      const lock = lockOn(requireDatabaseUrl(), 'revision-rollback');
      const dataMigrations = new RegistryDataMigrations(db.client, {
        logger: seedLogger,
        entries: [
          {
            name,
            revision: 1,
            run: async () => {
              throw new Error('a rollback must not run the entry again');
            },
          },
        ],
      });

      try {
        const summary = await runBootstrapSequence({
          expected: MIGRATION_NAMES,
          ledger: new PrismaSchemaLedger(db.client),
          lock,
          seeder: new CountingSeeder(),
          dataMigrations,
          migrator: new CountingMigrator(),
          logger: silent,
        });

        expect(summary.dataMigrations).toEqual({ applied: [], unknown: [], cachesFlushed: false });
        expect(warnings.some((line) => line.includes(name) && /above this build/.test(line))).toBe(true);
        expect(await db.client.dataMigration.findUniqueOrThrow({ where: { name } })).toMatchObject({ revision: 2 });
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
          expect(waiter.query).toContain('pg_advisory_xact_lock');

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

    it("refuses at release when the lock's connection ended while it was held, and leaves no lock behind", async () => {
      const lock = lockOn(requireDatabaseUrl(), 'terminated');

      try {
        await lock.acquire();
        // What a pooler set to end idle transactions, or a failed connection, does to the lock mid-boot.
        const ended = await admin.query<{ ended: boolean }>(
          `SELECT pg_terminate_backend(pid) AS ended FROM pg_stat_activity WHERE application_name = 'bge-bootstrap:terminated'`,
        );
        expect(ended.rows.map((row) => row.ended)).toEqual([true]);

        await expect(lock.release()).rejects.toBeInstanceOf(LockLostError);
      } finally {
        await lock.close();
      }

      // The backend gives its locks up as it exits, just after it reports the end.
      const deadline = Date.now() + 5_000;
      while ((await bootstrapLocks(db, true)) > 0) {
        if (Date.now() > deadline) throw new Error('the terminated connection still holds the bootstrap lock');
        await sleep(25);
      }
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

    it("reports a lost lock from assertHeld as soon as its connection's failure arrives, and release then has nothing to give back", async () => {
      const lock = lockOn(requireDatabaseUrl(), 'assert-held');

      try {
        await lock.acquire();
        expect(() => lock.assertHeld()).not.toThrow();
        await admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'bge-bootstrap:assert-held'`,
        );

        const deadline = Date.now() + 5_000;
        let reported: unknown;
        while (reported === undefined) {
          try {
            lock.assertHeld();
          } catch (error) {
            reported = error;
          }
          if (Date.now() > deadline) throw new Error('assertHeld never reported the terminated connection');
          await sleep(25);
        }
        expect(reported).toBeInstanceOf(LockLostError);
        await expect(lock.release()).resolves.toBeUndefined();
      } finally {
        await lock.close();
      }
    });

    it('waits out a held lock under a statement_timeout shorter than an attempt, and names the holder', async () => {
      await withBarrier(async (barrier) => {
        await barrier.holder.query('SELECT pg_advisory_lock(hashtextextended($1::text, 0))', [BOOTSTRAP_LOCK_NAME]);
        // A database role with a short statement_timeout, as some managed Postgres
        // services give their roles: it would cancel the 500ms wait at 200ms.
        const lock = new PgAdvisoryLock({
          connectionString: withSetting(requireDatabaseUrl(), 'statement_timeout', '200'),
          logger: silent,
          applicationName: 'bge-bootstrap:statement-timeout',
          attemptMs: 500,
        });

        try {
          const run = lock.acquire({ deadlineAt: systemClock.now() + 1_200 });
          await expect(run).rejects.toBeInstanceOf(LockNotAcquiredError);
          await expect(run).rejects.toThrow(`pid ${barrier.holder.pid}`);
        } finally {
          await lock.close();
          await barrier.holder.query('SELECT pg_advisory_unlock(hashtextextended($1::text, 0))', [BOOTSTRAP_LOCK_NAME]);
        }
      });
    });

    it("keeps the lock through Postgres's idle-transaction timeout, however long the sequence leaves its transaction idle", async () => {
      const lock = new PgAdvisoryLock({
        connectionString: withSetting(requireDatabaseUrl(), 'idle_in_transaction_session_timeout', '200'),
        logger: silent,
        applicationName: 'bge-bootstrap:idle-timeout',
      });

      try {
        await lock.acquire();
        // Three times the timeout, idle in the lock's transaction, as while the sequence migrates.
        await sleep(600);
        expect(await bootstrapLocks(db, true)).toBe(1);
        expect(() => lock.assertHeld()).not.toThrow();
        await expect(lock.release()).resolves.toBeUndefined();
      } finally {
        await lock.close();
      }

      expect(await bootstrapLocks(db, true)).toBe(0);
    });

    it("keeps the lock through Postgres 17's transaction timeout, however long the sequence holds its transaction", async () => {
      const lock = new PgAdvisoryLock({
        connectionString: withSetting(requireDatabaseUrl(), 'transaction_timeout', '200'),
        logger: silent,
        applicationName: 'bge-bootstrap:transaction-timeout',
      });

      try {
        await lock.acquire();
        // Three times the timeout since the lock's transaction began, as while the sequence migrates.
        await sleep(600);
        expect(await bootstrapLocks(db, true)).toBe(1);
        expect(() => lock.assertHeld()).not.toThrow();
        await expect(lock.release()).resolves.toBeUndefined();
      } finally {
        await lock.close();
      }

      expect(await bootstrapLocks(db, true)).toBe(0);
    });

    it('waits on a held lock over a slow link without taking the round trips for a database that did not answer', async () => {
      await withBarrier(async (barrier) => {
        await barrier.holder.query('SELECT pg_advisory_lock(hashtextextended($1::text, 0))', [BOOTSTRAP_LOCK_NAME]);
        // 150ms each way. An attempt's own round trips must fit the grace, or every
        // attempt is abandoned as unanswered and the holder is never named.
        const link = await slowLink(requireDatabaseUrl(), 150);
        const logger = recordingLogger();
        const lock = new PgAdvisoryLock({
          connectionString: link.url,
          logger,
          applicationName: 'bge-bootstrap:slow-link',
          attemptMs: 500,
          attemptGraceMs: 900,
        });

        try {
          const run = lock.acquire({ deadlineAt: systemClock.now() + 4_000 });
          await expect(run).rejects.toBeInstanceOf(LockNotAcquiredError);
          await expect(run).rejects.toThrow(`held by pid ${barrier.holder.pid}`);
          expect(logger.lines.filter((line) => /did not answer/.test(line))).toEqual([]);
          expect(link.connections()).toBe(1);
        } finally {
          await lock.close();
          await link.close();
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
      const real = createPrismaCliMigrator({ migrationUrl: sandboxUrl(), logger: silent, projectRoot: WORKSPACE_ROOT });
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

/**
 * The migration credential (#445): the migrations apply as one database role,
 * and every process role runs as another that holds only what it was granted.
 *
 * Booted through `runBootstrap`, configuration and all, against a database of
 * its own: the migration database role must own it, which the shared sandbox
 * above does not allow. Database roles belong to the whole Postgres server, so the
 * names are this block's own and are dropped at the end. Like the sandbox, it
 * needs a Postgres server where the harness may create roles and databases.
 */
describe('the migration credential against Postgres', () => {
  const DATABASE = 'bge_migration_credential_e2e';
  const MIGRATION_ROLE = 'bge_e2e_migrator';
  const APP_ROLE = 'bge_e2e_app';
  const PASSWORD = 'e2e-password';

  let admin: Client;

  /** The harness's Postgres server, inside this block's database, in the default schema the grants name. */
  const inDatabase = (credentials?: { user: string; password: string }): string => {
    const url = new URL(requireDatabaseUrl());
    if (credentials) {
      url.username = credentials.user;
      url.password = credentials.password;
    }
    url.pathname = `/${DATABASE}`;
    url.searchParams.delete('schema');
    return url.toString();
  };
  const urlAs = (user: string, password = PASSWORD) => inDatabase({ user, password });

  /** Empty and owned by the migration database role; with the grants docs/BOOTSTRAP.md gives, unless told otherwise. */
  async function freshDatabase(options: { grants: boolean }): Promise<void> {
    await admin.query(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${DATABASE}" OWNER "${MIGRATION_ROLE}"`);
    if (!options.grants) return;

    // Default privileges belong to one database, so they are set inside it.
    const inside = new Client({ connectionString: inDatabase() });
    await inside.connect();
    try {
      await inside.query(`GRANT USAGE ON SCHEMA public TO "${APP_ROLE}"`);
      await inside.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${MIGRATION_ROLE}" IN SCHEMA public ` +
          `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${APP_ROLE}"`,
      );
      await inside.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${MIGRATION_ROLE}" IN SCHEMA public ` +
          `GRANT USAGE, SELECT ON SEQUENCES TO "${APP_ROLE}"`,
      );
    } finally {
      await inside.end();
    }
  }

  function recordingNestLogger(): LoggerService & { readonly lines: string[] } {
    const lines: string[] = [];
    // The bootstrap's structured lines arrive as objects carrying `msg`.
    const text = (message: unknown) =>
      typeof message === 'object' && message !== null && 'msg' in message ? String(message.msg) : String(message);
    const push = (level: string) => (message: unknown) => void lines.push(`${level}: ${text(message)}`);
    return {
      lines,
      log: push('log'),
      warn: push('warn'),
      error: push('error'),
      debug: push('debug'),
      verbose: push('verbose'),
    };
  }

  /**
   * One process's bootstrap, configured through the environment as a
   * container's is. The api is the process given the real CLI migrator.
   */
  async function boot(options: {
    readonly applicationName: string;
    readonly databaseUrl: string;
    readonly migrationUrl: string;
    readonly logger?: LoggerService;
  }): Promise<BootstrapSummary> {
    const saved = {
      DATABASE_URL: process.env['DATABASE_URL'],
      DATABASE_MIGRATION_URL: process.env['DATABASE_MIGRATION_URL'],
    };
    process.env['DATABASE_URL'] = options.databaseUrl;
    process.env['DATABASE_MIGRATION_URL'] = options.migrationUrl;

    try {
      return await runBootstrap({
        applicationName: options.applicationName,
        logger: options.logger ?? recordingNestLogger(),
        migrator:
          options.applicationName === 'api'
            ? (context) => createPrismaCliMigrator({ ...context, projectRoot: WORKSPACE_ROOT })
            : undefined,
        waitMs: 5_000,
        schemaPollMs: 500,
      });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: requireDatabaseUrl() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
    for (const role of [MIGRATION_ROLE, APP_ROLE]) {
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${PASSWORD}'`);
    }
  });

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
    for (const role of [MIGRATION_ROLE, APP_ROLE]) {
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    }
    await admin.end();
  });

  describe('with the default privileges granted before the first boot', () => {
    beforeAll(async () => {
      await freshDatabase({ grants: true });
    });

    // DATABASE_URL names a database role that may not create a table, so the
    // migrations apply only if both the migrator and the Prisma CLI it runs
    // took DATABASE_MIGRATION_URL.
    it('the api migrates as the migration database role, seeds as the database role in DATABASE_URL, and names the credential in its summary', async () => {
      const summary = await boot({
        applicationName: 'api',
        databaseUrl: urlAs(APP_ROLE),
        migrationUrl: urlAs(MIGRATION_ROLE),
      });

      expect(summary.migrationsApplied).toEqual([...MIGRATION_NAMES]);
      expect(summary.seedsRun).toBe(true);
      expect(summary.migrationCredential).toEqual({
        variable: 'DATABASE_MIGRATION_URL',
        user: MIGRATION_ROLE,
        host: new URL(requireDatabaseUrl()).host,
      });
      expect(JSON.stringify(summary)).not.toContain(PASSWORD);

      const app = createTestDatabase(urlAs(APP_ROLE));
      const raw = new Client({ connectionString: urlAs(APP_ROLE) });
      await raw.connect();
      try {
        const owners = await raw.query<{ tableowner: string }>(
          "SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'",
        );
        expect(owners.rows.map((row) => row.tableowner)).toEqual([MIGRATION_ROLE]);
        expect(await app.client.permission.count()).toBe(CATALOG_MANIFEST.permissions.length);
        expect(await app.client.gameLength.count()).toBeGreaterThan(0);

        await expect(raw.query('CREATE TABLE intruder (id integer)')).rejects.toMatchObject({ code: '42501' });
      } finally {
        await raw.end();
        await app.close();
      }
    });

    it('a process that applies no migrations warns when it is given the migration credential, naming the variable and its process role', async () => {
      const logger = recordingNestLogger();

      const summary = await boot({
        applicationName: 'worker',
        databaseUrl: urlAs(APP_ROLE),
        migrationUrl: urlAs(MIGRATION_ROLE),
        logger,
      });

      expect(summary.state).toBe('in-sync');
      expect(logger.lines.filter((line) => line.includes('DATABASE_MIGRATION_URL'))).toEqual([
        expect.stringMatching(/^warn: DATABASE_MIGRATION_URL is set for the worker process role/),
      ]);
    });
  });

  it('a wrong password in DATABASE_MIGRATION_URL refuses the boot', async () => {
    await freshDatabase({ grants: true });

    const run = boot({
      applicationName: 'api',
      databaseUrl: urlAs(APP_ROLE),
      migrationUrl: urlAs(MIGRATION_ROLE, 'not-the-password'),
    });

    await expect(run).rejects.toBeInstanceOf(MigrateDeployFailedError);
  });

  it('without the default privileges: the read after migrating is refused naming the database role in DATABASE_URL, and so is the next boot', async () => {
    await freshDatabase({ grants: false });
    const configured = { applicationName: 'api', databaseUrl: urlAs(APP_ROLE), migrationUrl: urlAs(MIGRATION_ROLE) };

    const first = boot(configured);
    await expect(first).rejects.toBeInstanceOf(LedgerAccessDeniedError);
    await expect(first).rejects.toThrow(
      `the database role '${APP_ROLE}' in DATABASE_URL may not read _prisma_migrations`,
    );

    // The migrations did apply; on the next boot the same read comes first.
    const next = boot(configured);
    await expect(next).rejects.toBeInstanceOf(LedgerAccessDeniedError);
  });
});

/**
 * The bootstrap lock through PgBouncer in transaction pooling (#596), where a
 * server whose `DATABASE_URL` names a connection pooler takes it.
 *
 * Three server connections behind the pooler, fewer than its clients, so it
 * shares them: one for the lock's holder, one for a waiter's attempts, and one
 * left for the boots' own queries. The ledger reads, the seeds and the data
 * migrations go through the pooler too, as on a server whose `DATABASE_URL`
 * names one; the migrator takes a direct URL, as Prisma Migrate needs, and so
 * does the client that watches `pg_locks`, which the pooler could keep
 * waiting. A database of its own, empty at the start, so the first boot has
 * the whole chain to apply.
 */
describe('the bootstrap lock through a transaction pooler', () => {
  const DATABASE = 'bge_pooler_e2e';
  const SERVER_CONNECTIONS = 3;

  let admin: Client;
  let pooler: PgBouncer;
  /** Direct: the observer, and the arrangements around a boot. */
  let database: TestDatabase;
  /** Through the pooler: what a boot reads and writes with. */
  let pooledDatabase: TestDatabase;
  let direct: string;
  let pooled: string;

  /** Clients of the pooler, each holding a server connection in a transaction of its own until `end`. */
  async function pinnedServerConnections(count: number): Promise<{ clients: Client[]; end: () => Promise<void> }> {
    const clients: Client[] = [];
    const end = async () => {
      for (const client of clients) {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
      }
    };
    try {
      for (let i = 0; i < count; i += 1) {
        const client = new Client({ connectionString: pooled });
        await client.connect();
        clients.push(client);
        await client.query('BEGIN');
      }
    } catch (error) {
      await end();
      throw error;
    }
    return { clients, end };
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: requireDatabaseUrl() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${DATABASE}"`);

    const url = new URL(requireDatabaseUrl());
    url.pathname = `/${DATABASE}`;
    direct = url.toString();
    database = createTestDatabase(direct);
    pooler = await startPgBouncer({ databaseUrl: requireDatabaseUrl(), serverConnections: SERVER_CONNECTIONS });
    pooled = pooler.pooled(direct);
    pooledDatabase = createTestDatabase(pooled);
  });

  afterAll(async () => {
    await pooledDatabase?.close();
    await database?.close();
    await pooler?.stop();
    await admin.query(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
    await admin.end();
  });

  it('two api boots: the second waits behind the first on another server connection, the chain is applied once, and the seeds run one after the other', async () => {
    const real = createPrismaCliMigrator({ migrationUrl: direct, logger: silent, projectRoot: WORKSPACE_ROOT });
    let migrating!: () => void;
    const firstMigrates = new Promise<void>((resolve) => (migrating = resolve));
    let proceed!: () => void;
    const gate = new Promise<void>((resolve) => (proceed = resolve));
    // The first boot holds the lock until the second is seen waiting for it.
    const migrator = new CountingMigrator({
      apply: async (pending) => {
        migrating();
        await gate;
        await real.apply(pending);
      },
    });
    const seeder = new CountingSeeder(realSeeds(pooledDatabase.client));
    const locks = [lockOn(pooled, 'pooled-a'), lockOn(pooled, 'pooled-b')];
    const boot = (lock: PgAdvisoryLock) =>
      runBootstrapSequence({
        expected: MIGRATION_NAMES,
        ledger: new PrismaSchemaLedger(pooledDatabase.client),
        lock,
        seeder,
        dataMigrations: realDataMigrations(pooledDatabase.client),
        migrator,
        logger: silent,
      });

    const first = boot(locks[0]);
    let second: Promise<BootstrapSummary> | undefined;

    try {
      await Promise.race([
        firstMigrates,
        first.then(() => Promise.reject(new Error('the first boot finished without migrating'))),
      ]);
      second = boot(locks[1]);

      // A session lock goes back to the pooler with its server connection: the
      // second boot, handed that connection, takes the lock again and reaches
      // the migrator too.
      const deadline = Date.now() + 10_000;
      while ((await bootstrapLocks(database, false)) === 0) {
        if (migrator.calls > 1) throw new Error('the second boot took the lock the first one holds');
        if (Date.now() > deadline) throw new Error('the second boot never queued behind the bootstrap lock');
        await sleep(25);
      }
      proceed();

      const [a, b] = await Promise.all([first, second]);

      expect(migrator.calls).toBe(1);
      expect(a.migrationsApplied).toEqual([...MIGRATION_NAMES]);
      expect(b.state).toBe('in-sync');
      expect(seeder.spans).toHaveLength(2);
      const [[, firstEnd], [secondStart]] = [...seeder.spans].sort((x, y) => x[0] - y[0]);
      expect(secondStart).toBeGreaterThanOrEqual(firstEnd);
    } finally {
      proceed();
      await Promise.allSettled([first, second]);
      await Promise.all(locks.map((lock) => lock.close()));
    }
  });

  it('leaves no lock_timeout on the server connections its attempts ran on', async () => {
    // An attempt that waits out its timeout, then one that takes the lock.
    const holder = new Client({ connectionString: direct });
    await holder.connect();
    const lock = lockOn(pooled, 'pooled-timeout');

    try {
      await holder.query('SELECT pg_advisory_lock(hashtextextended($1::text, 0))', [BOOTSTRAP_LOCK_NAME]);
      await expect(lock.acquire({ deadlineAt: systemClock.now() + 700 })).rejects.toBeInstanceOf(LockNotAcquiredError);
      await holder.query('SELECT pg_advisory_unlock(hashtextextended($1::text, 0))', [BOOTSTRAP_LOCK_NAME]);
      await lock.acquire();
      await lock.release();
    } finally {
      await lock.close();
      await holder.end();
    }

    // Every server connection at once, each held by a transaction of its own.
    const pinned = await pinnedServerConnections(SERVER_CONNECTIONS);
    try {
      const settings = await Promise.all(
        pinned.clients.map((client) => client.query<{ lock_timeout: string }>('SHOW lock_timeout')),
      );
      expect(settings.map((result) => result.rows[0].lock_timeout)).toEqual(Array(SERVER_CONNECTIONS).fill('0'));
    } finally {
      await pinned.end();
    }
  });

  it('gives up at the deadline while the pooler has no server connection free for its attempt', async () => {
    // The attempt then waits in the pooler's queue, where lock_timeout cannot reach it.
    const pinned = await pinnedServerConnections(SERVER_CONNECTIONS);
    const lock = lockOn(pooled, 'pooled-starved');

    try {
      const started = systemClock.now();
      const run = lock.acquire({ deadlineAt: started + 1_000 });

      await expect(run).rejects.toBeInstanceOf(LockNotAcquiredError);
      await expect(run).rejects.toThrow(/no server connection free/);
      expect(systemClock.now() - started).toBeLessThan(5_000);
    } finally {
      await lock.close();
      await pinned.end();
    }
  });
});
