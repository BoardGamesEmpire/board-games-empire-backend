import { makeRedisConfig } from '@bge/redis';
import type { DynamicModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CACHE_FLUSH } from './bootstrap-options';
import { BootstrapModule } from './bootstrap.module';
import type { CacheFlush } from './ports';
import { RedisKeyFlush } from './redis-key-flush';

// The cache is a capability the entrypoint passes, like the migrator (#236):
// only a context given one loads the Redis config and registers the flush.
// Read off the dynamic module's metadata. `ConfigModule.forRoot` is stubbed:
// the real one reads `.env`, validates `DATABASE_URL` and writes the result
// into `process.env`, which is the application's business, not this spec's,
// and would fail the whole worker wherever no `.env` exists.

const providerTokens = (module: DynamicModule) =>
  (module.providers ?? []).map((provider) =>
    typeof provider === 'object' && 'provide' in provider ? provider.provide : provider,
  );

describe('BootstrapModule.forRoot', () => {
  const redis = makeRedisConfig({ namespace: 'redis.cache', envPrefix: 'REDIS_' });
  let configForRoot: jest.SpyInstance;

  const loaded = () => (configForRoot.mock.calls[0]?.[0] as { load?: unknown[] } | undefined)?.load ?? [];

  beforeEach(() => {
    configForRoot = jest.spyOn(ConfigModule, 'forRoot').mockResolvedValue({ module: ConfigModule });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads the Redis config and registers the flush when the entrypoint passes a cache', () => {
    const module = BootstrapModule.forRoot({
      applicationName: 'api',
      cache: { redis, flushPatterns: ['api:cache:bge:user:permissions:*'] },
    });

    expect(providerTokens(module)).toContain(CACHE_FLUSH);
    expect(loaded()).toContain(redis.config);
  });

  it('gives the flush a client that connects lazily, so a boot that never flushes closes it without a round trip', async () => {
    const module = BootstrapModule.forRoot({
      applicationName: 'api',
      cache: { redis, flushPatterns: ['api:cache:bge:user:permissions:*'] },
    });
    const provider = (module.providers ?? []).find(
      (candidate) => typeof candidate === 'object' && 'provide' in candidate && candidate.provide === CACHE_FLUSH,
    ) as { useFactory: (connection: unknown) => CacheFlush } | undefined;

    // An unroutable address: a client that tried to connect would hang here.
    const flush = provider?.useFactory({
      username: '',
      password: undefined,
      database: undefined,
      socket: { host: '192.0.2.1', port: 6379, tls: false },
    });

    expect(flush).toBeInstanceOf(RedisKeyFlush);
    await expect(flush?.close()).resolves.toBeUndefined();
  });

  it('loads neither for a process that passes none', () => {
    const module = BootstrapModule.forRoot({ applicationName: 'worker' });

    expect(providerTokens(module)).not.toContain(CACHE_FLUSH);
    expect(loaded()).not.toContain(redis.config);
  });
});
