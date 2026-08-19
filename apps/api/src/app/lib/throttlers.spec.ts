import { DEFAULT_THROTTLER_NAME, USER_THROTTLER_NAME } from '@bge/feedback';
import { seconds } from '@nestjs/throttler';
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
    const [ip] = createThrottlers(configWith({ 'throttle.ttlMs': seconds(60), 'throttle.limit': 20 }));

    expect(ip.name).toBe(DEFAULT_THROTTLER_NAME);
    // An identity, and that is the point: the bug was a unit conversion living
    // here. Any arithmetic reintroduced on this path fails this assertion.
    expect(ip.ttl).toBe(60_000);
    expect(ip.limit).toBe(20);
  });

  it('gives the user tier the same window as the IP tier', () => {
    const [ip, user] = createThrottlers(configWith({ 'throttle.ttlMs': seconds(30), 'throttle.limit': 5 }));

    expect(user.name).toBe(USER_THROTTLER_NAME);
    expect(user.ttl).toBe(ip.ttl);
  });

  it('registers exactly the IP and user tiers', () => {
    const throttlers = createThrottlers(configWith({ 'throttle.ttlMs': seconds(60), 'throttle.limit': 20 }));

    expect(throttlers.map((throttler) => throttler.name)).toEqual([DEFAULT_THROTTLER_NAME, USER_THROTTLER_NAME]);
  });

  it('refuses to boot on a missing window rather than defaulting one', () => {
    // `getOrThrow` is deliberate: a throttler silently falling back to some
    // built-in window is the same class of invisible failure as #293 itself.
    expect(() => createThrottlers(configWith({ 'throttle.limit': 20 }))).toThrow(/throttle\.ttlMs/);
  });
});

describe('throttle configuration', () => {
  const read = (env: NodeJS.ProcessEnv): { ttlMs: number; limit: number } => {
    const previous = process.env;

    process.env = { ...previous, ...env };

    try {
      return throttleConfig() as unknown as { ttlMs: number; limit: number };
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
