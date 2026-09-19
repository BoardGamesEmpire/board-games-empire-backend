import { DEFAULT_THROTTLER_NAME, USER_THROTTLER_NAME } from '@bge/feedback';
import type { ExecutionContext } from '@nestjs/common';
import { seconds, type ThrottlerOptions } from '@nestjs/throttler';
import Joi from 'joi';
import throttleConfig, { throttleConfigValidationSchema } from '../configuration/throttle.config';
import { createThrottlers } from './throttlers';

/**
 * These specs exist because of #293: `THROTTLE_TTL` defaulted to `60` while
 * `@nestjs/throttler` reads `ttl` in milliseconds, so the app shipped a 60ms
 * window that no test could see. The window was wrong at the seam between the
 * config namespace and the throttler option, where each side was individually
 * defensible, so the assertions below deliberately span that seam rather than
 * checking either end alone.
 */

/** The three keys `createThrottlers` reads, so a spec can vary one without restating the others. */
const baseConfig = (overrides: Record<string, number> = {}) => ({
  'throttle.ttlMs': seconds(60),
  'throttle.limit': 20,
  'throttle.trustedProxyHops': 0,
  ...overrides,
});

/** A ConfigService stand-in over a flat namespace map; `getOrThrow` is all this path uses. */
function configWith(values: Record<string, number>) {
  return {
    getOrThrow: <T>(key: string): T => {
      if (!(key in values)) {
        throw new Error(`Unexpected config key: ${key}`);
      }

      return values[key] as T;
    },
  };
}

describe('createThrottlers', () => {
  it('passes the configured window through to the IP tier unchanged', () => {
    const [ip] = createThrottlers(configWith(baseConfig()));

    expect(ip.name).toBe(DEFAULT_THROTTLER_NAME);
    // An identity, and that is the point: the bug was a unit conversion living
    // here. Any arithmetic reintroduced on this path fails this assertion.
    expect(ip.ttl).toBe(60_000);
    expect(ip.limit).toBe(20);
  });

  it('gives the user tier the same window as the IP tier', () => {
    const [ip, user] = createThrottlers(configWith(baseConfig({ 'throttle.ttlMs': seconds(30), 'throttle.limit': 5 })));

    expect(user.name).toBe(USER_THROTTLER_NAME);
    expect(user.ttl).toBe(ip.ttl);
  });

  it('sets blockDuration explicitly on both tiers rather than inheriting the window', () => {
    // #342: the guard resolves `routeOrClassBlockDuration || namedThrottler.blockDuration || ttl`,
    // so an unset field is indistinguishable from a deliberate one at the call site.
    // These assert the field is PRESENT; the value it carries is asserted below.
    const [ip, user] = createThrottlers(configWith(baseConfig()));

    expect(ip.blockDuration).toBeDefined();
    expect(user.blockDuration).toBeDefined();
  });

  it('blocks for exactly one window on both tiers', () => {
    // Equal to `ttl` on purpose, and NOT because that is the default — see the
    // `blockDuration` note in `throttlers.ts`. Under `RedisThrottlerStorage` a
    // shorter block would not let a refused caller back in early (the hit key
    // outlives the block), so it would only make `Retry-After` promise a return
    // that cannot happen. Equal to the window is what makes the header true.
    const [ip, user] = createThrottlers(configWith(baseConfig({ 'throttle.ttlMs': seconds(90) })));

    expect(ip.blockDuration).toBe(seconds(90));
    expect(user.blockDuration).toBe(seconds(90));
  });

  it('registers exactly the IP and user tiers', () => {
    const throttlers = createThrottlers(configWith(baseConfig()));

    expect(throttlers.map((throttler) => throttler.name)).toEqual([DEFAULT_THROTTLER_NAME, USER_THROTTLER_NAME]);
  });

  describe('the IP tier tracker (#340)', () => {
    /** Runs a tier's tracker over a request carrying a forwarded chain. */
    const trackedBy = async (tier: ThrottlerOptions, forwardedFor: string, peer = '10.0.0.9') =>
      tier.getTracker?.(
        { headers: { 'x-forwarded-for': forwardedFor }, socket: { remoteAddress: peer } },
        {} as ExecutionContext,
      );

    it('does not leave the IP tier on the guard default', () => {
      // The guard's own tracker returns `req.ip`, which Express draws from the
      // LEFTMOST `X-Forwarded-For` entry — a value the client sends.
      const [ip] = createThrottlers(configWith(baseConfig()));

      expect(ip.getTracker).toBeDefined();
    });

    it('builds the tracker from throttle.trustedProxyHops, not from another key', () => {
      // Existence alone passes if this is wired to `throttle.limit`, to a
      // literal, or to nothing — the same invisible-seam defect #293 was, which
      // is the whole reason this file spans the seam rather than either end.
      // So: configure one hop and assert the tracker actually steps one back.
      const [ip] = createThrottlers(configWith(baseConfig({ 'throttle.trustedProxyHops': 1 })));

      return expect(trackedBy(ip, 'client-claimed, 198.51.100.4')).resolves.toBe('198.51.100.4');
    });

    it('steps back exactly as many hops as the key says', () => {
      const [ip] = createThrottlers(configWith(baseConfig({ 'throttle.trustedProxyHops': 2 })));

      return expect(trackedBy(ip, 'client-claimed, 198.51.100.4, 10.0.0.8')).resolves.toBe('198.51.100.4');
    });

    it('ignores the forwarded chain entirely at the default of zero hops', () => {
      const [ip] = createThrottlers(configWith(baseConfig()));

      return expect(trackedBy(ip, 'client-claimed')).resolves.toBe('10.0.0.9');
    });

    it('refuses to boot on a missing hop count rather than assuming one', () => {
      expect(() => createThrottlers(configWith({ 'throttle.ttlMs': seconds(60), 'throttle.limit': 20 }))).toThrow(
        /throttle\.trustedProxyHops/,
      );
    });
  });

  it('refuses to boot on a missing window rather than defaulting one', () => {
    // `getOrThrow` is deliberate: a throttler silently falling back to some
    // built-in window is the same class of invisible failure as #293 itself.
    expect(() => createThrottlers(configWith({ 'throttle.limit': 20 }))).toThrow(/throttle\.ttlMs/);
  });
});

describe('throttle configuration', () => {
  type ThrottleNamespace = { ttlMs: number; limit: number; trustedProxyHops: number };

  const read = (env: NodeJS.ProcessEnv): ThrottleNamespace => {
    const previous = process.env;

    process.env = { ...previous, ...env };

    try {
      return throttleConfig() as unknown as ThrottleNamespace;
    } finally {
      process.env = previous;
    }
  };

  it('reads THROTTLE_TTL_MS as milliseconds, with no conversion applied', () => {
    expect(read({ THROTTLE_TTL_MS: '30000' }).ttlMs).toBe(30_000);
  });

  it('defaults to a one-minute window', () => {
    expect(read({ THROTTLE_TTL_MS: undefined }).ttlMs).toBe(60_000);
  });

  it('rejects a seconds-shaped window at boot rather than running a 60ms one', () => {
    // The migration hazard the rename cannot cover on its own: someone moving a
    // stale value onto the new key. Joi is where that becomes loud (#293).
    const schema = Joi.object(throttleConfigValidationSchema);

    expect(schema.validate({ THROTTLE_TTL_MS: 60 }).error).toBeDefined();
    expect(schema.validate({ THROTTLE_TTL_MS: 60_000 }).error).toBeUndefined();
  });

  it('defaults the trusted hop count to zero, which trusts no forwarded entry', () => {
    // The safe end of the range: an unset value must never mean "believe the
    // header", because that is the bypass #340 closed.
    expect(read({ THROTTLE_TRUSTED_PROXY_HOPS: undefined }).trustedProxyHops).toBe(0);
  });

  it('parses a configured hop count as a number, not a string', () => {
    // `createIpTracker` compares it with `<=` and does arithmetic on it; a
    // string survives both and indexes the chain wrongly.
    expect(read({ THROTTLE_TRUSTED_PROXY_HOPS: '2' }).trustedProxyHops).toBe(2);
  });

  it('rejects a negative hop count, and accepts zero', () => {
    // `.min(0)` rather than `.positive()`: zero is the default and means "trust
    // none of it", so the floor has to admit it while refusing nonsense.
    const schema = Joi.object(throttleConfigValidationSchema);

    expect(schema.validate({ THROTTLE_TRUSTED_PROXY_HOPS: -1 }).error).toBeDefined();
    expect(schema.validate({ THROTTLE_TRUSTED_PROXY_HOPS: 0 }).error).toBeUndefined();
    expect(schema.validate({ THROTTLE_TRUSTED_PROXY_HOPS: 2 }).error).toBeUndefined();
  });

  it('rejects a zero limit, which the guard would read as "reject everything"', () => {
    const schema = Joi.object(throttleConfigValidationSchema);

    expect(schema.validate({ THROTTLE_LIMIT: 0 }).error).toBeDefined();
    expect(schema.validate({ THROTTLE_LIMIT: 20 }).error).toBeUndefined();
  });

  it('no longer reads the old seconds-shaped THROTTLE_TTL', () => {
    // The rename is what makes the milliseconds convention safe to adopt: a
    // stale `THROTTLE_TTL=60` in someone's `.env` is inert (ConfigModule runs
    // with `allowUnknown`), where under the old name it would have been read
    // as a 60ms window with nothing to indicate it (#293).
    expect(read({ THROTTLE_TTL: '60', THROTTLE_TTL_MS: undefined }).ttlMs).toBe(60_000);
  });

  it('names the unit in the validation schema, since the failure mode is silent', () => {
    // Joi types `Description.flags` as `{}`; narrow to the one flag being read.
    const { flags } = throttleConfigValidationSchema.THROTTLE_TTL_MS.describe() as {
      flags?: { description?: string };
    };

    expect(flags?.description).toMatch(/MILLISECONDS/);
  });
});
