import { actorUserId, getActorSnapshotFromCls } from '@bge/actor-context';
import { applyDecorators, SetMetadata, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Throttle, type ThrottlerGetTrackerFunction, type ThrottlerOptions } from '@nestjs/throttler';

/**
 * Tiered rate limiting for feedback submission (issue #45): a per-source-IP
 * limit AND an independent per-authenticated-user limit on the same route.
 *
 * `@nestjs/throttler` models each tier as a named throttler that runs on every
 * request. The built-in `default` throttler already tracks by IP, so the IP
 * tier is just a per-route `@Throttle({ default })` override. The per-user tier
 * needs a second named throttler (`user`) with a user-id tracker — registered
 * globally in `ThrottlerModule` via {@link createUserThrottler}, but kept inert
 * everywhere except routes that opt in with {@link FeedbackSubmissionThrottle}.
 *
 * Why the user id comes from CLS and not `req.user`: the global `ThrottlerGuard`
 * runs BEFORE `AuthGuard` (guard registration order in `AppModule`), so
 * better-auth has not attached `req.user` yet when the tracker runs.
 * `HttpActorMiddleware` populates the actor into CLS before any guard, so that
 * is the only reliable source at this point.
 */

/** Name of the per-authenticated-user throttler; paired with the IP-based `default`. */
export const USER_THROTTLER_NAME = 'user';

/**
 * Route marker read by {@link createUserThrottler}'s `skipIf`. The `user`
 * throttler is registered globally, so without an explicit opt-in it would
 * throttle every authenticated route; this key gates it to routes that want it.
 */
export const PER_USER_THROTTLE_KEY = 'feedback:per-user-throttle';

// Stateless metadata reader; safe to construct outside DI.
const reflector = new Reflector();

/** Tracks by authenticated user id, read from CLS (see file header). */
export const getUserTracker: ThrottlerGetTrackerFunction = () => {
  const { actor } = getActorSnapshotFromCls();
  // Guarded by `skipUserThrottle` (skips when no user), so '' is never counted.
  return (actor && actorUserId(actor)) ?? '';
};

/**
 * Skips the `user` throttler unless the route opted in AND an authenticated
 * user is present. Unauthenticated requests to an opted-in route fall through
 * to the IP tier and are then rejected by `AuthGuard` — they must never share
 * a single empty-string user bucket.
 */
export const skipUserThrottle = (context: ExecutionContext): boolean => {
  const optedIn = reflector.getAllAndOverride<boolean>(PER_USER_THROTTLE_KEY, [
    context.getHandler(),
    context.getClass(),
  ]);

  if (optedIn !== true) {
    return true;
  }

  const { actor } = getActorSnapshotFromCls();

  return !actor || actorUserId(actor) === null;
};

/**
 * Builds the global `user` named throttler. `limit` is a sentinel that is never
 * enforced: opted-in routes override it via `@Throttle`, and every other route
 * is skipped by `skipIf` — it exists only because `ThrottlerOptions.limit` is
 * required. `ttl` is likewise a placeholder overridden per route.
 */
export const createUserThrottler = (ttl: number): ThrottlerOptions => ({
  name: USER_THROTTLER_NAME,
  ttl,
  limit: Number.MAX_SAFE_INTEGER,
  getTracker: getUserTracker,
  skipIf: skipUserThrottle,
});

/**
 * Applies the full tiered submission policy to a route: the per-user tier
 * opt-in marker plus both `@Throttle` overrides (IP via `default`, user via
 * `user`). Bundling them in one decorator keeps the marker and the throttle
 * overrides from drifting apart.
 */
export const FeedbackSubmissionThrottle = (opts: { userLimit: number; ipLimit: number; ttl: number }) =>
  applyDecorators(
    SetMetadata(PER_USER_THROTTLE_KEY, true),
    Throttle({
      default: { limit: opts.ipLimit, ttl: opts.ttl },
      [USER_THROTTLER_NAME]: { limit: opts.userLimit, ttl: opts.ttl },
    }),
  );
