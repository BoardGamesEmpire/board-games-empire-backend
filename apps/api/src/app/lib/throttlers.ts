import { createUserThrottler, DEFAULT_THROTTLER_NAME } from '@bge/feedback';
import type { ThrottlerOptions } from '@nestjs/throttler';

/**
 * The slice of `ConfigService` this factory uses. Structural rather than the
 * class itself so a spec can pass a plain object without casting through
 * `unknown` — a cast there would swallow exactly the signature drift these
 * specs exist to catch.
 */
interface ThrottleConfigReader {
  getOrThrow<T>(key: string): T;
}

/**
 * Builds the global throttler set: `default` tracks by source IP and applies to
 * every route, and `user` tracks by authenticated user but stays inert unless a
 * route opts in (feedback submission does — 30/user/hr + 100/IP/hr, issue #45).
 *
 * "Applies to every route" is per route, not across them: `ThrottlerGuard`
 * hashes the controller and handler name into the storage key, so the limit
 * below is a ceiling on each endpoint separately.
 *
 * Extracted from `AppModule` rather than inlined into `ThrottlerModule.forRootAsync`
 * so it can be asserted directly. The defect this guards against (#293) lived in
 * exactly this seam: the config namespace was right, the throttler option was
 * right, and the value changed meaning as it crossed between them. An inline
 * factory is unreachable from a spec, which is why nothing caught it.
 *
 * Every value here is milliseconds, end to end — see `throttle.config.ts`.
 */
export const createThrottlers = (config: ThrottleConfigReader): ThrottlerOptions[] => {
  const ttlMs = config.getOrThrow<number>('throttle.ttlMs');

  return [
    {
      name: DEFAULT_THROTTLER_NAME,
      ttl: ttlMs,
      limit: config.getOrThrow<number>('throttle.limit'),
    },
    createUserThrottler(ttlMs),
  ];
};
