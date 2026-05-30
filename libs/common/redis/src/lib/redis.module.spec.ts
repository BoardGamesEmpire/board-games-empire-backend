import { Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import type { Redis, RedisOptions } from 'iovalkey';
import type { BgeRedisConnectionConfig, BgeRedisModuleAsyncOptions } from './redis-connection.config';
import { RedisLifecycleManager } from './redis-lifecycle.service';
import { RedisModule } from './redis.module';
import { CACHE_REDIS_CLIENT, QUEUE_REDIS_CLIENT } from './redis.tokens';

// ---------------------------------------------------------------------------
// Mock the internal factory rather than the upstream `iovalkey` package.
// Mocking an internal module file is reliable across SWC/jest interop;
// mocking a default-exported CJS package is not.
//
// `toIoRedisOptions` is preserved (real implementation) so the test can still
// assert on the options that *would* be passed to a real client. Only
// `createRedisClient` is replaced — it now returns a lightweight fake whose
// `quit` is a jest.fn() so the lifecycle tests can verify shutdown calls.
// ---------------------------------------------------------------------------

interface FakeRedisClient {
  options: RedisOptions;
  status: 'ready' | 'end' | 'close' | 'connecting';
  quit: jest.Mock<Promise<'OK'>, []>;
  disconnect: jest.Mock<void, []>;
}

const constructorCalls: RedisOptions[] = [];

jest.mock('./redis-client.factory', () => {
  const actual = jest.requireActual<typeof import('./redis-client.factory')>('./redis-client.factory');

  const createRedisClient = jest.fn(
    (config: BgeRedisConnectionConfig, overrides: Partial<RedisOptions> = {}): FakeRedisClient => {
      const options = actual.toIoRedisOptions(config, overrides);
      constructorCalls.push(options);
      return {
        options,
        status: 'ready',
        quit: jest.fn().mockResolvedValue('OK'),
        disconnect: jest.fn(),
      };
    },
  );

  return {
    __esModule: true,
    toIoRedisOptions: actual.toIoRedisOptions,
    createRedisClient,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConnectionConfig(overrides: Partial<BgeRedisConnectionConfig> = {}): BgeRedisConnectionConfig {
  return {
    database: 0,
    socket: { host: 'localhost', port: 6379, tls: false },
    ...overrides,
  };
}

async function buildTestModule(options: BgeRedisModuleAsyncOptions): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), RedisModule.forRootAsync(options)],
  }).compile();
}

function cacheOnly(): BgeRedisModuleAsyncOptions {
  return {
    cache: { useFactory: () => makeConnectionConfig({ database: 0 }) },
  };
}

function queueOnly(): BgeRedisModuleAsyncOptions {
  return {
    queue: { useFactory: () => makeConnectionConfig({ database: 2 }) },
  };
}

function both(): BgeRedisModuleAsyncOptions {
  return {
    cache: { useFactory: () => makeConnectionConfig({ database: 0 }) },
    queue: { useFactory: () => makeConnectionConfig({ database: 2 }) },
  };
}

beforeEach(() => {
  constructorCalls.length = 0;
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('RedisModule.forRootAsync — validation', () => {
  it('throws if neither cache nor queue is configured', () => {
    expect(() => RedisModule.forRootAsync({})).toThrow(/at least one of `cache` or `queue`/);
  });
});

// ---------------------------------------------------------------------------
// Both connections
// ---------------------------------------------------------------------------

describe('RedisModule.forRootAsync — cache + queue', () => {
  it('provides both CACHE_REDIS_CLIENT and QUEUE_REDIS_CLIENT', async () => {
    const module = await buildTestModule(both());
    expect(module.get(CACHE_REDIS_CLIENT)).toBeDefined();
    expect(module.get(QUEUE_REDIS_CLIENT)).toBeDefined();
  });

  it('creates two independent client instances', async () => {
    const module = await buildTestModule(both());
    const cache = module.get<Redis>(CACHE_REDIS_CLIENT);
    const queue = module.get<Redis>(QUEUE_REDIS_CLIENT);

    expect(cache).not.toBe(queue);
    expect(constructorCalls).toHaveLength(2);
  });

  it('cache client uses maxRetriesPerRequest: 3 (fail-fast)', async () => {
    const module = await buildTestModule(both());
    const cache = module.get<FakeRedisClient>(CACHE_REDIS_CLIENT);
    expect(cache.options.maxRetriesPerRequest).toBe(3);
  });

  it('queue client uses maxRetriesPerRequest: null (required by BullMQ)', async () => {
    const module = await buildTestModule(both());
    const queue = module.get<FakeRedisClient>(QUEUE_REDIS_CLIENT);
    expect(queue.options.maxRetriesPerRequest).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cache only
// ---------------------------------------------------------------------------

describe('RedisModule.forRootAsync — cache only', () => {
  it('provides CACHE_REDIS_CLIENT', async () => {
    const module = await buildTestModule(cacheOnly());
    expect(module.get(CACHE_REDIS_CLIENT)).toBeDefined();
  });

  it('does NOT register QUEUE_REDIS_CLIENT', async () => {
    const module = await buildTestModule(cacheOnly());
    expect(() => module.get(QUEUE_REDIS_CLIENT)).toThrow();
  });

  it('creates exactly one client instance', async () => {
    await buildTestModule(cacheOnly());
    expect(constructorCalls).toHaveLength(1);
  });

  it('lifecycle manager is still registered', async () => {
    const module = await buildTestModule(cacheOnly());
    expect(module.get(RedisLifecycleManager)).toBeInstanceOf(RedisLifecycleManager);
  });
});

// ---------------------------------------------------------------------------
// Queue only
// ---------------------------------------------------------------------------

describe('RedisModule.forRootAsync — queue only', () => {
  it('provides QUEUE_REDIS_CLIENT', async () => {
    const module = await buildTestModule(queueOnly());
    expect(module.get(QUEUE_REDIS_CLIENT)).toBeDefined();
  });

  it('does NOT register CACHE_REDIS_CLIENT', async () => {
    const module = await buildTestModule(queueOnly());
    expect(() => module.get(CACHE_REDIS_CLIENT)).toThrow();
  });

  it('creates exactly one client instance', async () => {
    await buildTestModule(queueOnly());
    expect(constructorCalls).toHaveLength(1);
  });

  it('queue client still uses maxRetriesPerRequest: null', async () => {
    const module = await buildTestModule(queueOnly());
    const queue = module.get<FakeRedisClient>(QUEUE_REDIS_CLIENT);
    expect(queue.options.maxRetriesPerRequest).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Async resolution
// ---------------------------------------------------------------------------

describe('RedisModule.forRootAsync — async config resolution', () => {
  it('awaits async useFactory before constructing the client', async () => {
    const module = await buildTestModule({
      cache: {
        useFactory: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return makeConnectionConfig({ socket: { host: 'async.example.com', port: 6379, tls: false } });
        },
      },
    });

    const cache = module.get<FakeRedisClient>(CACHE_REDIS_CLIENT);
    expect(cache.options.host).toBe('async.example.com');
  });

  it('passes injected dependencies positionally to the useFactory', async () => {
    const useFactory = jest.fn().mockReturnValue(makeConnectionConfig());

    await buildTestModule({
      cache: {
        inject: [ConfigService],
        useFactory,
      },
    });

    expect(useFactory).toHaveBeenCalledTimes(1);
    expect(useFactory.mock.calls[0][0]).toBeInstanceOf(ConfigService);
  });
});

// ---------------------------------------------------------------------------
// Global registration
// ---------------------------------------------------------------------------

describe('RedisModule — global registration', () => {
  it('CACHE_REDIS_CLIENT is injectable in feature modules without re-importing RedisModule', async () => {
    const featureModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), RedisModule.forRootAsync(both())],
      providers: [
        {
          provide: 'TEST_CONSUMER',
          inject: [CACHE_REDIS_CLIENT],
          useFactory: (client: Redis) => client,
        },
      ],
    }).compile();

    expect(featureModule.get('TEST_CONSUMER')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle manager
// ---------------------------------------------------------------------------

describe('RedisLifecycleManager', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('calls quit() on both clients when both are configured', async () => {
    const module = await buildTestModule(both());
    const lifecycle = module.get(RedisLifecycleManager);
    const cache = module.get<FakeRedisClient>(CACHE_REDIS_CLIENT);
    const queue = module.get<FakeRedisClient>(QUEUE_REDIS_CLIENT);

    await lifecycle.onApplicationShutdown('SIGTERM');

    expect(cache.quit).toHaveBeenCalledTimes(1);
    expect(queue.quit).toHaveBeenCalledTimes(1);
  });

  it('only quits the cache client when queue is not configured', async () => {
    const module = await buildTestModule(cacheOnly());
    const lifecycle = module.get(RedisLifecycleManager);
    const cache = module.get<FakeRedisClient>(CACHE_REDIS_CLIENT);

    await lifecycle.onApplicationShutdown('SIGTERM');

    expect(cache.quit).toHaveBeenCalledTimes(1);
  });

  it('only quits the queue client when cache is not configured', async () => {
    const module = await buildTestModule(queueOnly());
    const lifecycle = module.get(RedisLifecycleManager);
    const queue = module.get<FakeRedisClient>(QUEUE_REDIS_CLIENT);

    await lifecycle.onApplicationShutdown('SIGTERM');

    expect(queue.quit).toHaveBeenCalledTimes(1);
  });

  it('skips quit() on clients that are already closed', async () => {
    const module = await buildTestModule(both());
    const lifecycle = module.get(RedisLifecycleManager);
    const cache = module.get<FakeRedisClient>(CACHE_REDIS_CLIENT);
    const queue = module.get<FakeRedisClient>(QUEUE_REDIS_CLIENT);

    cache.status = 'end';

    await lifecycle.onApplicationShutdown('SIGTERM');

    expect(cache.quit).not.toHaveBeenCalled();
    expect(queue.quit).toHaveBeenCalledTimes(1);
  });

  it('logs an error when a quit() call rejects but does not throw', async () => {
    const module = await buildTestModule(both());
    const lifecycle = module.get(RedisLifecycleManager);
    const cache = module.get<FakeRedisClient>(CACHE_REDIS_CLIENT);
    const errorSpy = jest.spyOn(Logger.prototype, 'error');

    cache.quit.mockRejectedValueOnce(new Error('connection reset'));

    await expect(lifecycle.onApplicationShutdown('SIGTERM')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('connection reset'));
  });

  it('quits clients concurrently — one failure does not block the other', async () => {
    const module = await buildTestModule(both());
    const lifecycle = module.get(RedisLifecycleManager);
    const cache = module.get<FakeRedisClient>(CACHE_REDIS_CLIENT);
    const queue = module.get<FakeRedisClient>(QUEUE_REDIS_CLIENT);

    cache.quit.mockRejectedValueOnce(new Error('cache broken'));

    await lifecycle.onApplicationShutdown('SIGTERM');

    expect(queue.quit).toHaveBeenCalledTimes(1);
  });
});
