// Stubs the meter so the fail-open counter can be asserted without standing up
// a metric provider, following `pool-metrics-recorder.service.spec.ts`. The
// storage touches nothing else in `@opentelemetry/api`.
jest.mock('@opentelemetry/api', () => {
  const add = jest.fn();
  const createCounter = jest.fn(() => ({ add }));

  return { metrics: { getMeter: jest.fn(() => ({ createCounter })) } };
});

import { Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { RedisThrottlerStorage } from './redis-throttler.storage';

/** The `add` stub shared by every counter the mocked meter hands out. */
const failOpenAdds = (): jest.Mock =>
  (metrics.getMeter('bge-throttle').createCounter('throttle.storage.fail_open') as unknown as { add: jest.Mock }).add;

/**
 * The storage is the whole rate limiter as far as correctness goes: the guard
 * only asks a question and reads the answer. These specs cover what is ours
 * rather than the library's — how the script is dispatched, the record built
 * from its reply, and what happens when Redis will not or cannot answer (#341).
 *
 * The Lua itself runs against a real server; asserting its arithmetic against a
 * mock here would only assert the mock.
 */

type CallMock = jest.Mock<Promise<unknown>, unknown[]>;

/** A Redis stand-in over `call`, which is the only method this storage uses. */
function redisWith(impl: (command: string, ...args: unknown[]) => unknown) {
  const call: CallMock = jest.fn(async (command: unknown, ...args: unknown[]) => {
    const reply = impl(command as string, ...args);

    return reply instanceof Error ? Promise.reject(reply) : reply;
  });

  return { call } as unknown as ConstructorParameters<typeof RedisThrottlerStorage>[0] & { call: CallMock };
}

/** Answers every dispatch with one canned script reply. */
const redisReturning = (...replies: unknown[]) => {
  let index = 0;

  return redisWith(() => replies[Math.min(index++, replies.length - 1)]);
};

const noScript = () => new Error('NOSCRIPT No matching script. Please use EVAL.');

describe('RedisThrottlerStorage', () => {
  let error: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    failOpenAdds().mockClear();
  });

  afterEach(() => jest.restoreAllMocks());

  describe('dispatch', () => {
    it('sends the script digest rather than the script', async () => {
      // This runs on every request of every route, so shipping the ~1 KB body
      // each time would be a kilobyte of identical text per request.
      const redis = redisReturning([1, 60_000, 0, 0]);

      await new RedisThrottlerStorage(redis).increment('abc', 60_000, 20, 90_000, 'user');

      const [command, digest, keyCount, hitKey, blockKey, ...argv] = redis.call.mock.calls[0];
      expect(command).toBe('evalsha');
      expect(digest).toMatch(/^[0-9a-f]{40}$/);
      expect(keyCount).toBe(2);
      // Namespaced so buckets are identifiable in a shared database, and
      // distinct per throttler name so the two tiers cannot collide on one key.
      expect(hitKey).toBe('bge:throttle:user:abc');
      expect(blockKey).toBe('bge:throttle:user:abc:blocked');
      expect(argv).toEqual([60_000, 20, 90_000]);
    });

    it('falls back to EVAL when the server has not cached the script', async () => {
      // First call after boot, or after a SCRIPT FLUSH. The EVAL both answers
      // this request and caches the script for the next one.
      const redis = redisWith((command) => (command === 'evalsha' ? noScript() : [1, 60_000, 0, 0]));

      const record = await new RedisThrottlerStorage(redis).increment('k', 60_000, 20, 60_000, 'default');

      expect(redis.call.mock.calls.map(([command]) => command)).toEqual(['evalsha', 'eval']);
      expect(record.totalHits).toBe(1);
      expect(error).not.toHaveBeenCalled();
    });

    it('does not retry as EVAL for a failure that is not NOSCRIPT', async () => {
      // Re-sending the body on a connection error would double the traffic of an
      // outage; NOSCRIPT is the only rejection a retry can fix.
      const redis = redisWith(() => new Error('ECONNREFUSED'));

      await new RedisThrottlerStorage(redis).increment('k', 60_000, 20, 60_000, 'default');

      expect(redis.call.mock.calls.map(([command]) => command)).toEqual(['evalsha']);
    });

    it('does not run the script for a request the deadline already released', async () => {
      // The slow NOSCRIPT: a server that takes longer than the deadline and then
      // answers that it has never seen the script — a failover to a node with a
      // cold script cache. The request has already been allowed through by then,
      // so an EVAL here would run the script a SECOND time for it and charge the
      // caller's counter twice, with nothing waiting to read the answer.
      jest.useFakeTimers();
      try {
        const redis = redisWith((command) =>
          command === 'evalsha'
            ? new Promise((_resolve, reject) => setTimeout(() => reject(noScript()), 400))
            : [1, 60_000, 0, 0],
        );

        const pending = new RedisThrottlerStorage(redis).increment('k', 60_000, 20, 60_000, 'default');

        await jest.advanceTimersByTimeAsync(500);

        await expect(pending).resolves.toMatchObject({ totalHits: 0, isBlocked: false });
        expect(redis.call.mock.calls.map(([command]) => command)).toEqual(['evalsha']);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('the record it builds', () => {
    it('maps the script reply onto the fields the guard reads', async () => {
      const storage = new RedisThrottlerStorage(redisReturning([3, 57_000, 0, 0]));

      await expect(storage.increment('k', 60_000, 3, 60_000, 'default')).resolves.toEqual({
        totalHits: 3,
        timeToExpire: 57,
        isBlocked: false,
        timeToBlockExpire: 0,
      });
    });

    it('reports seconds, not milliseconds', async () => {
      // These two fields feed `Retry-After` and `X-RateLimit-Reset`, which are
      // SECONDS, while the script works in milliseconds throughout. Rounding up
      // rather than down: a `Retry-After` that expires fractionally early
      // invites a retry that is refused again.
      const storage = new RedisThrottlerStorage(redisReturning([21, 1_400, 1, 2_100]));

      const record = await storage.increment('k', 60_000, 20, 60_000, 'default');

      expect(record.timeToExpire).toBe(2);
      expect(record.timeToBlockExpire).toBe(3);
    });

    it('marks a blocked caller blocked', async () => {
      const storage = new RedisThrottlerStorage(redisReturning([21, 30_000, 1, 30_000]));

      await expect(storage.increment('k', 60_000, 20, 60_000, 'default')).resolves.toMatchObject({
        isBlocked: true,
        timeToBlockExpire: 30,
      });
    });
  });

  describe('failing open', () => {
    it('allows the request when Redis rejects, and says so', async () => {
      // Rate limiting is an abuse control, not a correctness control:
      // failing closed turns a Redis blip into a total outage of every route.
      const storage = new RedisThrottlerStorage(redisReturning(new Error('ECONNREFUSED')));

      await expect(storage.increment('k', 60_000, 20, 60_000, 'default')).resolves.toEqual({
        totalHits: 0,
        timeToExpire: 60,
        isBlocked: false,
        timeToBlockExpire: 0,
      });

      expect(error).toHaveBeenCalledTimes(1);
    });

    it('allows the request when Redis accepts the command but never answers', async () => {
      // The case `maxRetriesPerRequest` does not cover: a connected client whose
      // server has stopped replying. Without the deadline this promise never
      // settles, every request parks inside the guard, and the fail-open path
      // below is unreachable — which is the whole API stalling on the limiter.
      jest.useFakeTimers();
      try {
        const storage = new RedisThrottlerStorage(redisWith(() => new Promise(() => undefined)));
        const pending = storage.increment('k', 60_000, 20, 60_000, 'default');

        await jest.advanceTimersByTimeAsync(300);

        await expect(pending).resolves.toMatchObject({ isBlocked: false, totalHits: 0 });
      } finally {
        jest.useRealTimers();
      }
    });

    it('allows the request on a malformed reply rather than trusting a partial one', async () => {
      const storage = new RedisThrottlerStorage(redisReturning(['not', 'a', 'record']));

      await expect(storage.increment('k', 60_000, 20, 60_000, 'default')).resolves.toMatchObject({
        isBlocked: false,
        totalHits: 0,
      });

      expect(error).toHaveBeenCalledTimes(1);
    });

    it('logs once for an outage rather than once per request', async () => {
      // Ungated this is one serialized stack per request for the length of the
      // outage — tens of thousands of them, competing with the logs an operator
      // is reading to diagnose the incident that produced them.
      const storage = new RedisThrottlerStorage(redisReturning(new Error('down')));

      for (let attempt = 0; attempt < 50; attempt++) {
        await storage.increment('k', 60_000, 20, 60_000, 'default');
      }

      expect(error).toHaveBeenCalledTimes(1);
    });

    it('counts what it suppressed', async () => {
      const storage = new RedisThrottlerStorage(redisReturning(new Error('down')));

      for (let attempt = 0; attempt < 5; attempt++) {
        await storage.increment('k', 60_000, 20, 60_000, 'default');
      }

      expect(error.mock.calls[0][0]).toMatchObject({ suppressedSinceLastLog: 0 });
    });

    it('reports the suppressed count on the next line the gate lets through', async () => {
      // The assertion above only ever sees the first line, which is 0 by
      // definition. Without this one the whole counter could be deleted and the
      // suite would stay green — the number that says how bad the outage was is
      // the one nothing was checking.
      jest.useFakeTimers();
      try {
        const storage = new RedisThrottlerStorage(redisReturning(new Error('down')));

        for (let attempt = 0; attempt < 5; attempt++) {
          await storage.increment('k', 60_000, 20, 60_000, 'default');
        }
        expect(error).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(11_000);
        await storage.increment('k', 60_000, 20, 60_000, 'default');

        expect(error).toHaveBeenCalledTimes(2);
        expect(error.mock.calls[1][0]).toMatchObject({ suppressedSinceLastLog: 4 });
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not call a reply it cannot read a recovery', async () => {
      // Recovery used to be declared before the reply was validated, so a run of
      // malformed replies logged a recovery AND an error on every request: the
      // recovery cleared the gate, and the failure that followed walked straight
      // through it. Two lines per request is worse than the storm the gate was
      // added to stop.
      const storage = new RedisThrottlerStorage(redisReturning(['not', 'a', 'record']));

      for (let attempt = 0; attempt < 10; attempt++) {
        await storage.increment('k', 60_000, 20, 60_000, 'default');
      }

      expect(error).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
    });

    it('reports the next outage immediately once the counter answers again', async () => {
      // Otherwise the interval gate would swallow the start of a second incident
      // just because a first one happened recently.
      let healthy = false;
      const storage = new RedisThrottlerStorage(redisWith(() => (healthy ? [1, 60_000, 0, 0] : new Error('down'))));

      await storage.increment('k', 60_000, 20, 60_000, 'default');
      expect(error).toHaveBeenCalledTimes(1);

      healthy = true;
      await storage.increment('k', 60_000, 20, 60_000, 'default');

      healthy = false;
      await storage.increment('k', 60_000, 20, 60_000, 'default');

      expect(error).toHaveBeenCalledTimes(2);
    });
  });
  describe('counting the fail-opens', () => {
    it('counts a request it let through uncounted', async () => {
      const storage = new RedisThrottlerStorage(redisReturning(new Error('down')));

      await storage.increment('k', 60_000, 20, 60_000, 'default');

      expect(failOpenAdds()).toHaveBeenCalledWith(1, { throttler: 'default' });
    });

    it('counts every failure, including the ones the log gate suppresses', async () => {
      // The reason the metric exists at all (#341). The gate deliberately
      // emits one line per interval, so the logs cannot answer "how big was
      // it"; a count that shared the gate would be wrong in the same way.
      const storage = new RedisThrottlerStorage(redisReturning(new Error('down')));

      for (let attempt = 0; attempt < 10; attempt++) {
        await storage.increment('k', 60_000, 20, 60_000, 'default');
      }

      expect(error).toHaveBeenCalledTimes(1);
      expect(failOpenAdds()).toHaveBeenCalledTimes(10);
    });

    it('says which tier stopped being enforced', async () => {
      // The IP tier going open is a different exposure from the user tier
      // going open, and an unlabelled count cannot tell them apart.
      const storage = new RedisThrottlerStorage(redisReturning(new Error('down')));

      await storage.increment('k', 60_000, 20, 60_000, 'user');

      expect(failOpenAdds()).toHaveBeenCalledWith(1, { throttler: 'user' });
    });

    it('counts a reply it could not read, which is also a request let through', async () => {
      const storage = new RedisThrottlerStorage(redisReturning(['not', 'a', 'record']));

      await storage.increment('k', 60_000, 20, 60_000, 'default');

      expect(failOpenAdds()).toHaveBeenCalledTimes(1);
    });

    it('stays silent while the counter is answering', async () => {
      const storage = new RedisThrottlerStorage(redisReturning([1, 60_000, 0, 0]));

      await storage.increment('k', 60_000, 20, 60_000, 'default');

      expect(failOpenAdds()).not.toHaveBeenCalled();
    });
  });
});
