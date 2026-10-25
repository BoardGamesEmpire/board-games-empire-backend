import { DatabaseModule, DatabaseService } from '@bge/database';
import { PermissionsModule, PermissionsService } from '@bge/permissions';
import { CACHE_REDIS_CLIENT } from '@bge/redis';
import { Test, type TestingModule } from '@nestjs/testing';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'iovalkey';
import { ClsModule } from 'nestjs-cls';
import { permissionsCacheKey } from '../support/api-cache';
import { REDIS_IMAGE } from '../support/e2e-env';

/**
 * Permission graphs live in one store that every process reads (#786). Each
 * process used to cache them in its own cache-manager namespace, so an
 * eviction the api made never reached a graph the worker or the gateway
 * worker had cached, which kept serving it until its TTL ended.
 *
 * Two compiles of the real `PermissionsModule`, each over its own client of
 * one real Redis server (`REDIS_IMAGE`), stand in for the api and the worker,
 * so the module's own wiring decides where each writes. The database is a stub
 * that counts loads, so a load is the only way to see a miss. This spec starts
 * its own container, as `bootstrap/cache-flush` does, so it plants nothing in
 * the Redis the api uses.
 */
describe('permission graphs shared by every process (#786)', () => {
  const findUnique = jest.fn();
  const stubDb = { user: { findUnique } };

  let container: StartedRedisContainer;
  let redisA: Redis;
  let redisB: Redis;
  let modules: TestingModule[] = [];
  let api: PermissionsService;
  let worker: PermissionsService;

  /** One process's `PermissionsModule`, with `client` as its cache connection, as `RedisModule` provides it. */
  async function processOver(client: Redis): Promise<PermissionsService> {
    const module = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true }),
        {
          module: class CacheClient {},
          global: true,
          providers: [{ provide: CACHE_REDIS_CLIENT, useValue: client }],
          exports: [CACHE_REDIS_CLIENT],
        },
        PermissionsModule,
      ],
    })
      .overrideModule(DatabaseModule)
      .useModule({
        module: class StubDatabase {},
        providers: [{ provide: DatabaseService, useValue: stubDb }],
        exports: [DatabaseService],
      })
      .compile();

    modules.push(module);
    return module.get(PermissionsService);
  }

  beforeAll(async () => {
    container = await new RedisContainer(REDIS_IMAGE).start();
    redisA = new Redis(container.getConnectionUrl());
    redisB = new Redis(container.getConnectionUrl());
  }, 120_000);

  beforeEach(async () => {
    await redisA.flushdb();
    // One role, so the graph is cached: one holding none is served uncached (#490).
    findUnique.mockReset().mockResolvedValue({ id: 'u1', roles: [{ role: { name: 'User', permissions: [] } }] });
    api = await processOver(redisA);
    worker = await processOver(redisB);
  });

  afterEach(async () => {
    await Promise.all(modules.map((module) => module.close()));
    modules = [];
  });

  afterAll(async () => {
    await redisA.quit();
    await redisB.quit();
    await container.stop();
  });

  it('an eviction made in one process is seen by the next read in another (#786)', async () => {
    await worker.getUserRoleGraph('u1');
    await worker.getUserRoleGraph('u1');
    expect(findUnique).toHaveBeenCalledTimes(1);

    await api.invalidateUser('u1');
    await worker.getUserRoleGraph('u1');

    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('keeps the graph under the shared namespace (#786)', async () => {
    await worker.getUserRoleGraph('u1');

    expect(await redisA.exists(permissionsCacheKey(PermissionsService.userGraphCacheKey('u1')))).toBe(1);
    // The name docs/BOOTSTRAP.md and docs/REDIS.md give operators.
    expect(await redisA.exists('namespace:permissions:cache:bge:user:permissions:u1')).toBe(1);
  });
});
