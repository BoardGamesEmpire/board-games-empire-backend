import { CACHE_REDIS_CLIENT, QUEUE_REDIS_CLIENT } from '@bge/redis';
import { SecureHttpService } from '@bge/secure-http';
import { StorageService } from '@bge/storage';
import type { MockDatabaseService } from '@bge/testing';
import { createTestingModuleWithDb } from '@bge/testing';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { HealthCheckResult } from '@nestjs/terminus';
import { TerminusModule } from '@nestjs/terminus';
import type { TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { CacheRedisHealthIndicator } from './indicators/cache-redis.health-indicator';
import { HttpTargetHealthIndicator } from './indicators/http-target.health-indicator';
import { PrismaHealthIndicator } from './indicators/prisma.health-indicator';
import { QueueRedisHealthIndicator } from './indicators/queue-redis.health-indicator';
import { StorageHealthIndicator } from './indicators/storage.health-indicator';

// ---------------------------------------------------------------------------
// Config mocking — same pattern as libs/api/well-known security-txt spec.
// ConfigService.get is a typed jest.fn backed by a keyed map.
// ---------------------------------------------------------------------------

interface MockHealthConfig {
  enableHealthChecks?: boolean;
  httpHealthCheckUrls?: string[];
}

function buildMockConfigService(config: MockHealthConfig): jest.Mocked<Pick<ConfigService, 'get'>> {
  const configMap: Record<string, unknown> = {
    'health.enableHealthChecks': config.enableHealthChecks ?? true,
    'health.httpHealthCheckUrls': config.httpHealthCheckUrls ?? [],
  };

  return {
    get: jest.fn().mockImplementation(<T>(key: string, defaultValue?: T): T => {
      return (configMap[key] as T | undefined) ?? (defaultValue as T);
    }),
  };
}

// ---------------------------------------------------------------------------
// Redis client mocking — minimal Pick<Redis, 'ping'> stand-ins. The cache and
// queue health indicators only call `.ping()`. Passing `undefined` instead
// of a mock simulates an unbound CACHE_REDIS_CLIENT / QUEUE_REDIS_CLIENT,
// which exercises the indicators' @Optional() injection path.
// ---------------------------------------------------------------------------

interface MockRedis {
  ping: jest.Mock;
}

function makeRedis(pingResponse: 'PONG' | string = 'PONG'): MockRedis {
  return {
    ping: jest.fn().mockResolvedValue(pingResponse),
  };
}

// ---------------------------------------------------------------------------
// Test module factory
// ---------------------------------------------------------------------------

interface BuildOptions extends MockHealthConfig {
  /** Pass `null` to simulate CACHE_REDIS_CLIENT not being bound. */
  cacheRedis?: MockRedis | null;

  /** Pass `null` to simulate QUEUE_REDIS_CLIENT not being bound. */
  queueRedis?: MockRedis | null;

  /** Pass `null` (default) to simulate StorageService unbound → "not configured". */
  storage?: { ping: jest.Mock } | null;
}

/**
 * The HTTP checks go through the real `HttpTargetHealthIndicator` onto a mocked
 * `SecureHttpService`, so a test asserts what would leave the server: the mock
 * is the handle for "was anything sent" (#1509).
 */
interface MockSecureHttp {
  request: jest.Mock;
}

function makeSecureHttp(): MockSecureHttp {
  return { request: jest.fn().mockResolvedValue({ status: 200 }) };
}

interface BuildResult {
  cacheRedis: MockRedis | null;
  configService: jest.Mocked<Pick<ConfigService, 'get'>>;
  controller: HealthController;
  db: MockDatabaseService;
  http: MockSecureHttp;
  module: TestingModule;
  queueRedis: MockRedis | null;
}

async function buildController(options: BuildOptions = {}): Promise<BuildResult> {
  const cacheRedis = options.cacheRedis === null ? null : (options.cacheRedis ?? makeRedis());
  const queueRedis = options.queueRedis === null ? null : (options.queueRedis ?? makeRedis());
  const configService = buildMockConfigService(options);
  const http = makeSecureHttp();

  const { module, db } = await createTestingModuleWithDb({
    controllers: [HealthController],
    imports: [TerminusModule],
    providers: [
      PrismaHealthIndicator,
      CacheRedisHealthIndicator,
      QueueRedisHealthIndicator,
      StorageHealthIndicator,
      HttpTargetHealthIndicator,
      { provide: SecureHttpService, useValue: http },
      { provide: ConfigService, useValue: configService },
      ...(options.storage ? [{ provide: StorageService, useValue: options.storage }] : []),
      ...(cacheRedis !== null ? [{ provide: CACHE_REDIS_CLIENT, useValue: cacheRedis }] : []),
      ...(queueRedis !== null ? [{ provide: QUEUE_REDIS_CLIENT, useValue: queueRedis }] : []),
    ],
  });

  // Default the mocked $queryRaw to succeed; specific tests override.
  db.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

  return {
    controller: module.get(HealthController),
    module,
    db,
    configService,
    cacheRedis,
    queueRedis,
    http,
  };
}

/**
 * Type guard discriminating a real Terminus health-check result from the
 * `{ status: 'disabled' }` short-circuit returned by the Surrogate
 * pre-handler.
 */
function isHealthCheckResult(value: unknown): value is HealthCheckResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    (value as { status: string }).status !== 'disabled'
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HealthController', () => {
  describe('GET /health/live (liveness)', () => {
    it('returns { status: "ok" } synchronously', async () => {
      const { controller } = await buildController();

      expect(controller.live()).toEqual({ status: 'ok' });
    });

    it('returns ok even when ENABLE_HEALTH_CHECKS=false (liveness is never disabled)', async () => {
      const { controller } = await buildController({ enableHealthChecks: false });

      expect(controller.live()).toEqual({ status: 'ok' });
    });
  });

  describe('GET /health/ready (readiness)', () => {
    describe('healthy paths', () => {
      it('returns ok when database and both Redis connections are healthy', async () => {
        const { controller } = await buildController();

        const result = await controller.ready();

        if (!isHealthCheckResult(result)) {
          throw new Error('expected HealthCheckResult, got disabled response');
        }

        expect(result.status).toBe('ok');
        expect(result.info).toMatchObject({
          database: { status: 'up' },
          cache: { status: 'up' },
          queue: { status: 'up' },
        });
      });

      it('reports cache as "not configured" (still up) when CACHE_REDIS_CLIENT is unbound', async () => {
        const { controller } = await buildController({ cacheRedis: null });

        const result = await controller.ready();

        if (!isHealthCheckResult(result)) {
          throw new Error('expected HealthCheckResult, got disabled response');
        }

        expect(result.status).toBe('ok');
        expect(result.info?.cache).toEqual({ status: 'up', message: 'not configured' });
      });

      it('reports queue as "not configured" (still up) when QUEUE_REDIS_CLIENT is unbound', async () => {
        const { controller } = await buildController({ queueRedis: null });

        const result = await controller.ready();

        if (!isHealthCheckResult(result)) {
          throw new Error('expected HealthCheckResult, got disabled response');
        }

        expect(result.info?.queue).toEqual({ status: 'up', message: 'not configured' });
      });

      it('passes with both Redis connections unbound — minimum-config processes still ready', async () => {
        const { controller } = await buildController({ cacheRedis: null, queueRedis: null });

        const result = await controller.ready();

        if (!isHealthCheckResult(result)) {
          throw new Error('expected HealthCheckResult, got disabled response');
        }

        expect(result.status).toBe('ok');
        expect(result.info?.database).toEqual({ status: 'up' });
        expect(result.info?.cache).toEqual({ status: 'up', message: 'not configured' });
        expect(result.info?.queue).toEqual({ status: 'up', message: 'not configured' });
      });

      it('reports storage "not configured" (still up) when StorageService is unbound', async () => {
        const { controller } = await buildController();

        const result = await controller.ready();

        if (!isHealthCheckResult(result)) {
          throw new Error('expected HealthCheckResult, got disabled response');
        }

        expect(result.info?.storage).toEqual({ status: 'up', message: 'not configured' });
      });

      it('reports storage up when the backend ping resolves', async () => {
        const { controller } = await buildController({ storage: { ping: jest.fn().mockResolvedValue(undefined) } });

        const result = await controller.ready();

        if (!isHealthCheckResult(result)) {
          throw new Error('expected HealthCheckResult, got disabled response');
        }

        expect(result.info?.storage).toEqual({ status: 'up' });
      });
    });

    describe('unhealthy paths (Terminus throws ServiceUnavailableException)', () => {
      it('throws 503 when the database is down', async () => {
        const { controller, db } = await buildController();
        db.$queryRaw.mockRejectedValue(new Error('connection refused'));

        await expect(controller.ready()).rejects.toMatchObject({
          response: expect.objectContaining({
            status: 'error',
            error: expect.objectContaining({
              database: { status: 'down', message: 'connection refused' },
            }),
          }),
        });
      });

      it('throws 503 when cache Redis is down', async () => {
        const cacheRedis = makeRedis();
        cacheRedis.ping.mockRejectedValue(new Error('cache unreachable'));
        const { controller } = await buildController({ cacheRedis });

        await expect(controller.ready()).rejects.toMatchObject({
          response: expect.objectContaining({
            error: expect.objectContaining({
              cache: { status: 'down', message: 'cache unreachable' },
            }),
          }),
        });
      });

      it('throws 503 when queue Redis is down', async () => {
        const queueRedis = makeRedis();
        queueRedis.ping.mockRejectedValue(new Error('queue unreachable'));
        const { controller } = await buildController({ queueRedis });

        await expect(controller.ready()).rejects.toMatchObject({
          response: expect.objectContaining({
            error: expect.objectContaining({
              queue: { status: 'down', message: 'queue unreachable' },
            }),
          }),
        });
      });

      it('throws 503 when the storage backend is unavailable', async () => {
        const storage = { ping: jest.fn().mockRejectedValue(new Error('volume gone')) };
        const { controller } = await buildController({ storage });

        await expect(controller.ready()).rejects.toMatchObject({
          response: expect.objectContaining({
            error: expect.objectContaining({ storage: { status: 'down', message: 'volume gone' } }),
          }),
        });
      });
    });

    describe('disable behavior (Surrogate pre-handler)', () => {
      it('returns { status: "disabled" } when ENABLE_HEALTH_CHECKS=false', async () => {
        const { controller } = await buildController({ enableHealthChecks: false });

        const result = await controller.ready();

        expect(result).toEqual({ status: 'disabled' });
      });

      it('skips every indicator when disabled', async () => {
        const cacheRedis = makeRedis();
        const queueRedis = makeRedis();
        const { controller, db } = await buildController({
          enableHealthChecks: false,
          cacheRedis,
          queueRedis,
        });

        await controller.ready();

        expect(db.$queryRaw).not.toHaveBeenCalled();
        expect(cacheRedis.ping).not.toHaveBeenCalled();
        expect(queueRedis.ping).not.toHaveBeenCalled();
      });

      it('warn-logs a single message when entering the disabled path', async () => {
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const { controller } = await buildController({ enableHealthChecks: false });

        await controller.ready();

        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('disabled by configuration'));
      });
    });
  });

  describe('GET /health (detail / HTTP pings)', () => {
    // The config spec proves an unset HTTP_HEALTH_CHECK_URLS reads as no entries.
    it('sends nothing and answers ok with no HTTP target configured, the default (#1509)', async () => {
      const { controller, http } = await buildController();

      await expect(controller.detail()).resolves.toEqual({ status: 'ok', info: {}, error: {}, details: {} });
      expect(http.request).not.toHaveBeenCalled();
    });

    it('returns ok with an empty indicator set when HTTP_HEALTH_CHECK_URLS is empty', async () => {
      const { controller, http } = await buildController({ httpHealthCheckUrls: [] });

      const result = await controller.detail();

      if (!isHealthCheckResult(result)) {
        throw new Error('expected HealthCheckResult, got disabled response');
      }

      expect(result.status).toBe('ok');
      expect(Object.keys(result.info ?? {})).toHaveLength(0);
      expect(http.request).not.toHaveBeenCalled();
    });

    it('runs an HTTP check per well-formed name|url entry, through the outbound HTTP policy (#1509)', async () => {
      const { controller, http } = await buildController({
        httpHealthCheckUrls: ['google|https://www.google.com', 'github|https://www.github.com'],
      });

      await expect(controller.detail()).resolves.toMatchObject({
        info: { google: { status: 'up' }, github: { status: 'up' } },
      });
      expect(http.request).toHaveBeenCalledWith('https://www.google.com', expect.objectContaining({ method: 'GET' }));
      expect(http.request).toHaveBeenCalledWith('https://www.github.com', expect.objectContaining({ method: 'GET' }));
    });

    it('drops malformed entries instead of crashing', async () => {
      const { controller, http } = await buildController({
        httpHealthCheckUrls: [
          'valid|https://valid.example.com',
          'missingurl|',
          '|https://noname.example.com',
          'no-separator',
          '  |  ',
        ],
      });

      await controller.detail();

      expect(http.request).toHaveBeenCalledTimes(1);
      expect(http.request).toHaveBeenCalledWith('https://valid.example.com', expect.anything());
    });

    it('trims whitespace from name and url before pinging', async () => {
      const { controller, http } = await buildController({
        httpHealthCheckUrls: ['  github  |  https://github.com  '],
      });

      await expect(controller.detail()).resolves.toMatchObject({ info: { github: { status: 'up' } } });
      expect(http.request).toHaveBeenCalledWith('https://github.com', expect.anything());
    });

    it('returns { status: "disabled" } and skips pings when ENABLE_HEALTH_CHECKS=false', async () => {
      const { controller, http } = await buildController({
        enableHealthChecks: false,
        httpHealthCheckUrls: ['google|https://www.google.com'],
      });

      const result = await controller.detail();

      expect(result).toEqual({ status: 'disabled' });
      expect(http.request).not.toHaveBeenCalled();
    });
  });

  describe('module wiring', () => {
    it('resolves all three indicators from the DI container', async () => {
      const { module } = await buildController();

      expect(module.get(PrismaHealthIndicator)).toBeInstanceOf(PrismaHealthIndicator);
      expect(module.get(CacheRedisHealthIndicator)).toBeInstanceOf(CacheRedisHealthIndicator);
      expect(module.get(QueueRedisHealthIndicator)).toBeInstanceOf(QueueRedisHealthIndicator);
      expect(module.get(StorageHealthIndicator)).toBeInstanceOf(StorageHealthIndicator);
    });

    it('configService is resolved (Surrogate runConditions can access it on the controller)', async () => {
      const { module, configService } = await buildController();

      expect(module.get(ConfigService)).toBe(configService);
    });

    it('is exempt from the global rate limiter', () => {
      // The liveness docblock's own rule: a probe that can be silenced is
      // indistinguishable from no probe. A 429 silences it, and because
      // `blockDuration` defaults to the window, the refusal is total for a full
      // minute — long enough to cross `failureThreshold` and restart the pod,
      // which clears the in-process counters and leaves the cadence that caused
      // it unchanged. `@SkipThrottle()` writes `THROTTLER:SKIP` + the throttler
      // name; the key is internal to @nestjs/throttler and spelled out rather
      // than imported, so a version that changes it fails here loudly.
      expect(Reflect.getMetadata('THROTTLER:SKIPdefault', HealthController)).toBe(true);
    });
  });
});
