import {
  PgAdvisoryLock,
  PrismaSchemaLedger,
  RedisKeyFlush,
  runBootstrapSequence,
  RunSeedsSeeder,
  type BootstrapLogger,
  type Migrator,
} from '@bge/bootstrap';
import { CATALOG_MANIFEST, MIGRATION_NAMES, reconcileCatalog, SystemRole } from '@bge/database';
import { PermissionsService } from '@bge/permissions';
import KeyvValkey from '@keyv/valkey';
import type { Logger } from '@nestjs/common';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'iovalkey';
import Keyv from 'keyv';
import { REDIS_IMAGE } from '../support/e2e-env';
import { createTestDatabase, requireDatabaseUrl, type TestDatabase } from '../support/test-db';

/**
 * The cache flush through the real seeds phase (#236). A catalog reconcile
 * that wrote rows removes every cached ability graph and API-key scope graph
 * from a real Valkey; a reconcile that wrote nothing leaves them, and keys
 * outside the patterns are never touched. The graphs are written the way the
 * api's CacheModule writes them, through Keyv and the Valkey adapter under the
 * api's namespace, so the physical keys here are the ones production has (the
 * api's own spec pins its namespace constant to these patterns). DB-only on
 * the harness database, which is in sync and seeded, so removing one grant is
 * what makes the next reconcile write. The DB-only runner provisions no Redis,
 * so this spec starts its own container.
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

describe('the cache flush after a reconcile that wrote rows', () => {
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
  });

  afterAll(async () => {
    await redis.quit();
    await container.stop();
    await db.close();
  });

  async function boot() {
    const lock = new PgAdvisoryLock({
      connectionString: requireDatabaseUrl(),
      logger: silent,
      applicationName: 'bge-bootstrap:flush-e2e',
    });
    try {
      return await runBootstrapSequence({
        expected: MIGRATION_NAMES,
        ledger: new PrismaSchemaLedger(db.client),
        lock,
        seeder: new RunSeedsSeeder(db.client, {
          logger: silentSeedLogger,
          flush: new RedisKeyFlush(redis, PATTERNS),
        }),
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

  it('leaves the caches alone when the reconcile wrote nothing', async () => {
    await prime();

    const summary = await boot();

    expect(summary.reconcile).toEqual(expect.objectContaining({ mutations: 0, cachesFlushed: false }));
    expect(await present(CACHED)).toEqual([1, 1, 1]);
  });
});
