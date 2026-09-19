import { createUserThrottler, DEFAULT_THROTTLER_NAME, throttleWindow } from '@bge/feedback';
import type { ThrottlerOptions } from '@nestjs/throttler';
import { createIpTracker } from './ip-tracker';

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
 *
 * WHY `blockDuration` IS SPELLED OUT (#342). The guard resolves it as
 * `routeOrClassBlockDuration || namedThrottler.blockDuration || ttl`, so leaving
 * it unset is indistinguishable at the call site from choosing the window on
 * purpose. It is set here so the value reads as a decision.
 *
 * WHY THE VALUE IS THE WINDOW, AND NOT SOMETHING SHORTER. `blockDuration` does
 * not mean what it looks like it means, and it means two different things
 * depending on the storage underneath:
 *
 *   - Under the library's own storages, a block expiring RESETS the hit counter
 *     (`ThrottlerStorageService.resetBlockdRequest` zeroes `totalHits`;
 *     `@nest-lab`'s Redis script re-`SET`s the hit key to 1). There, a
 *     one-minute block on an hour-long window is not a gentler policy — it
 *     hands back a fresh budget every minute, sixty times the stated one.
 *   - Under `RedisThrottlerStorage`, which is what this app runs, it does not:
 *     a blocked caller is not counted and the hit key keeps its own expiry, so
 *     the caller stays refused until the WINDOW ends however short the block is.
 *
 * Under ours, then, a short block buys nothing and costs honesty: `Retry-After`
 * would promise a minute while the caller is actually out for the hour, and
 * every promise would bring back a request that cannot succeed. Equal to the
 * window is the value that makes the header true.
 *
 * Neither storage can express "let them back in as their oldest request ages
 * out" — that needs a token bucket or a timestamp set rather than one counter
 * with one expiry. The lever that IS expressible is the other direction: a
 * block LONGER than the window, which escalates rather than softens. Nothing
 * wants that yet.
 */
export const createThrottlers = (config: ThrottleConfigReader): ThrottlerOptions[] => {
  const ttlMs = config.getOrThrow<number>('throttle.ttlMs');

  return [
    {
      name: DEFAULT_THROTTLER_NAME,
      ...throttleWindow(ttlMs),
      limit: config.getOrThrow<number>('throttle.limit'),
      // Not the guard's default. See `createIpTracker` — `req.ip` is drawn from
      // a header the client writes, so the tier it fed could not trip (#340).
      getTracker: createIpTracker(config.getOrThrow<number>('throttle.trustedProxyHops')),
    },
    createUserThrottler(ttlMs),
  ];
};
