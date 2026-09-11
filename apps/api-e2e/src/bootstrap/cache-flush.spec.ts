import {
  PgAdvisoryLock,
  PrismaSchemaLedger,
  RedisKeyFlush,
  RegistryDataMigrations,
  runBootstrapSequence,
  RunSeedsSeeder,
  type BootstrapLogger,
  type Migrator,
} from '@bge/bootstrap';
import {
  CATALOG_MANIFEST,
  MIGRATION_NAMES,
  reconcileCatalog,
  SystemRole,
  type DataMigrationEntry,
} from '@bge/database';
import { PermissionsService } from '@bge/permissions';
import KeyvValkey from '@keyv/valkey';
import type { Logger } from '@nestjs/common';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'iovalkey';
import Keyv from 'keyv';
import { REDIS_IMAGE } from '../support/e2e-env';
import { createTestDatabase, requireDatabaseUrl, type TestDatabase } from '../support/test-db';

/**
 * The cache flush through the real DML phases (#236). A catalog reconcile
 * that wrote rows removes every cached ability graph and API-key scope graph
 * from a real Valkey, and so does a data migration that applied; a boot that
 * wrote neither leaves them, and keys outside the patterns are never touched.
 * The graphs are written the way the api's CacheModule writes them, through
 * Keyv and the Valkey adapter under the api's namespace, so the physical keys
 * here are the ones production has (the api's own spec pins its namespace
 * constant to these patterns). DB-only on the harness database, which is in
 * sync and seeded, so removing one grant is what makes the next reconcile
 * write. The DB-only runner provisions no Redis, so this spec starts its own
 * container.
 */

const silent: BootstrapLogger = { log: () => undefined, warn: () => undefined };
const silentSeedLogger = {
  log: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

/** In sync, so the migrator is never asked; being present is what makes this boot the writer. */
const neverMigrates: Migrator = {
  apply: async (pending) => {
    throw new Error(`the harness database should be in sync; asked to apply ${pending.join(', ')}`);
  },
};

/** The api's `API_CACHE_NAMESPACE`; the api composes its flush patterns from it exactly as below. */
const API_CACHE_NAMESPACE = 'api:cache';
const PATTERNS = [PermissionsService.userGraphCacheKey('*'), PermissionsService.apiKeyScopeCacheKey('*')].map(
  (key) => `${API_CACHE_NAMESPACE}:${key}`,
);
/** Logical keys, as the CacheModule's callers pass them; Keyv puts the namespace in front. */
const GRAPHS = [
  PermissionsService.userGraphCacheKey('u1'),
  PermissionsService.userGraphCacheKey('u2'),
  PermissionsService.apiKeyScopeCacheKey('k1'),
];
const CACHED = GRAPHS.map((key) => `${API_CACHE_NAMESPACE}:${key}`);
const BYSTANDERS = [`${API_CACHE_NAMESPACE}:bge:session:other`, 'bge:user:permissions:no-namespace'];
/** A data migration this spec registers and applies; its ledger row is removed after each test. */
const ENTRY = '20260901000000_e2e_flush_probe';

describe('the cache flush after a reconcile that wrote rows or a data migration that applied', () => {
  let db: TestDatabase;
  let container: StartedRedisContainer;
  let redis: Redis;

  beforeAll(async () => {
    db = createTestDatabase();
    container = await new RedisContainer(REDIS_IMAGE).start();
    redis = new Redis(container.getConnectionUrl());
  }, 120_000);

  afterEach(async () => {
    await reconcileCatalog(db.client, CATALOG_MANIFEST, { logger: silent });
    await db.client.dataMigration.deleteMany({ where: { name: ENTRY } });
  });

  afterAll(async () => {
    await redis.quit();
    await container.stop();
    await db.close();
  });

  /** One boot with the api's wiring: one flush, handed to the seeds phase and the data migrations alike. */
  async function boot(entries: readonly DataMigrationEntry[] = []) {
    const lock = new PgAdvisoryLock({
      connectionString: requireDatabaseUrl(),
      logger: silent,
      applicationName: 'bge-bootstrap:flush-e2e',
    });
    const flush = new RedisKeyFlush(redis, PATTERNS);
    try {
      return await runBootstrapSequence({
        expected: MIGRATION_NAMES,
        ledger: new PrismaSchemaLedger(db.client),
        lock,
        seeder: new RunSeedsSeeder(db.client, { logger: silentSeedLogger, flush }),
        dataMigrations: new RegistryDataMigrations(db.client, { logger: silentSeedLogger, flush, entries }),
        migrator: neverMigrates,
        logger: silent,
      });
    } finally {
      await lock.close();
    }
  }

  /** Writes the graphs the way the api does, and the bystanders: one inside the namespace, one raw. */
  async function prime(): Promise<void> {
    const keyv = new Keyv({ store: new KeyvValkey(redis), namespace: API_CACHE_NAMESPACE });
    await Promise.all([...GRAPHS, 'bge:session:other'].map((key) => keyv.set(key, { primed: true })));
    await redis.set('bge:user:permissions:no-namespace', '{}');
    expect(await present(CACHED)).toEqual([1, 1, 1]);
  }

  const present = (keys: readonly string[]) => Promise.all(keys.map((key) => redis.exists(key)));

  it('removes every graph under the patterns once the reconcile has written, and nothing beside them', async () => {
    await prime();
    await db.client.rolePermission.deleteMany({
      where: { role: { name: SystemRole.User }, permission: { slug: 'read:game' } },
    });

    const summary = await boot();

    expect(summary.seedsRun).toBe(true);
    expect(summary.reconcile).toEqual(expect.objectContaining({ grantsCreated: 1, mutations: 1, cachesFlushed: true }));
    expect(await present(CACHED)).toEqual([0, 0, 0]);
    expect(await present(BYSTANDERS)).toEqual([1, 1]);
  });

  it('removes the graphs when a data migration applied, though the reconcile wrote nothing', async () => {
    await prime();

    const summary = await boot([{ name: ENTRY, revision: 1, run: async () => undefined }]);

    expect(summary.reconcile).toEqual(expect.objectContaining({ mutations: 0, cachesFlushed: false }));
    expect(summary.dataMigrations).toEqual({ applied: [ENTRY], unknown: [], cachesFlushed: true });
    expect(await present(CACHED)).toEqual([0, 0, 0]);
    expect(await present(BYSTANDERS)).toEqual([1, 1]);
  });

  it('leaves the caches alone when the reconcile wrote nothing and no data migration applied', async () => {
    await prime();

    const summary = await boot();

    expect(summary.reconcile).toEqual(expect.objectContaining({ mutations: 0, cachesFlushed: false }));
    expect(summary.dataMigrations).toEqual({ applied: [], unknown: [], cachesFlushed: false });
    expect(await present(CACHED)).toEqual([1, 1, 1]);
  });
});
