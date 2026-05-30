import { CACHE_REDIS_CLIENT, type Redis } from '@bge/redis';
import { Provider } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { Test } from '@nestjs/testing';
import { CacheRedisHealthIndicator } from './cache-redis.health-indicator';

async function buildIndicator(client: Pick<Redis, 'ping'> | undefined) {
  const providers: Provider[] = [CacheRedisHealthIndicator];
  if (client !== undefined) {
    providers.push({ provide: CACHE_REDIS_CLIENT, useValue: client });
  }

  const module = await Test.createTestingModule({
    imports: [TerminusModule],
    providers,
  }).compile();

  return module.get(CacheRedisHealthIndicator);
}

describe('CacheRedisHealthIndicator', () => {
  describe('when CACHE_REDIS_CLIENT is not configured', () => {
    it('returns up with a "not configured" message', async () => {
      const indicator = await buildIndicator(undefined);

      const result = await indicator.isHealthy('cache');

      expect(result).toEqual({ cache: { status: 'up', message: 'not configured' } });
    });

    it('does not throw — readiness route stays green', async () => {
      const indicator = await buildIndicator(undefined);

      await expect(indicator.isHealthy('cache')).resolves.toBeDefined();
    });

    it('honors a custom key in the not-configured response', async () => {
      const indicator = await buildIndicator(undefined);

      const result = await indicator.isHealthy('primary-cache');

      expect(result).toEqual({ 'primary-cache': { status: 'up', message: 'not configured' } });
    });
  });

  describe('when CACHE_REDIS_CLIENT is configured', () => {
    let redis: jest.Mocked<Pick<Redis, 'ping'>>;

    beforeEach(() => {
      redis = {
        ping: jest.fn(),
      } satisfies Partial<jest.Mocked<Redis>> as jest.Mocked<Pick<Redis, 'ping'>>;
    });

    describe('healthy path', () => {
      it('returns up when PING returns PONG', async () => {
        redis.ping.mockResolvedValue('PONG');
        const indicator = await buildIndicator(redis);

        const result = await indicator.isHealthy('cache');

        expect(result).toEqual({ cache: { status: 'up' } });
      });

      it('uses the provided key in the result', async () => {
        redis.ping.mockResolvedValue('PONG');
        const indicator = await buildIndicator(redis);

        const result = await indicator.isHealthy('primary-cache');

        expect(result).toEqual({ 'primary-cache': { status: 'up' } });
      });

      it('defaults the key to "cache" when not provided', async () => {
        redis.ping.mockResolvedValue('PONG');
        const indicator = await buildIndicator(redis);

        const result = await indicator.isHealthy();

        expect(result).toEqual({ cache: { status: 'up' } });
      });

      it('calls ping exactly once per health check', async () => {
        redis.ping.mockResolvedValue('PONG');
        const indicator = await buildIndicator(redis);

        await indicator.isHealthy('cache');

        expect(redis.ping).toHaveBeenCalledTimes(1);
      });
    });

    describe('unhealthy paths', () => {
      it('returns down when PING returns a non-PONG response', async () => {
        redis.ping.mockResolvedValue('UNEXPECTED');
        const indicator = await buildIndicator(redis);

        const result = await indicator.isHealthy('cache');

        expect(result).toEqual({
          cache: { status: 'down', message: 'Unexpected PING response: UNEXPECTED' },
        });
      });

      it('returns down when ping rejects with an Error', async () => {
        redis.ping.mockRejectedValue(new Error('connection reset by peer'));
        const indicator = await buildIndicator(redis);

        const result = await indicator.isHealthy('cache');

        expect(result).toEqual({
          cache: { status: 'down', message: 'connection reset by peer' },
        });
      });

      it('handles non-Error rejection values', async () => {
        redis.ping.mockRejectedValue('string rejection');
        const indicator = await buildIndicator(redis);

        const result = await indicator.isHealthy('cache');

        expect(result).toEqual({
          cache: { status: 'down', message: 'string rejection' },
        });
      });

      it('uses the provided key in down results', async () => {
        redis.ping.mockRejectedValue(new Error('down'));
        const indicator = await buildIndicator(redis);

        const result = await indicator.isHealthy('primary-cache');

        expect(result).toEqual({
          'primary-cache': { status: 'down', message: 'down' },
        });
      });

      it('does not throw — the indicator returns the down result directly', async () => {
        redis.ping.mockRejectedValue(new Error('down'));
        const indicator = await buildIndicator(redis);

        await expect(indicator.isHealthy('cache')).resolves.toBeDefined();
      });
    });
  });
});
