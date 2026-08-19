import { getActorSnapshotFromCls } from '@bge/actor-context';
import type { ExecutionContext } from '@nestjs/common';
import { hours } from '@nestjs/throttler';
import {
  FEEDBACK_IP_THROTTLE_LIMIT,
  FEEDBACK_THROTTLE_TTL_MS,
  FEEDBACK_USER_THROTTLE_LIMIT,
} from '../constants/feedback.constants';
import {
  createUserThrottler,
  DEFAULT_THROTTLER_NAME,
  FeedbackSubmissionThrottle,
  getUserTracker,
  PER_USER_THROTTLE_KEY,
  skipUserThrottle,
  USER_THROTTLER_NAME,
} from './feedback-throttler';

// Keep the real `actorUserId` (pure); stub only the CLS reader.
jest.mock('@bge/actor-context', () => ({
  ...jest.requireActual('@bge/actor-context'),
  getActorSnapshotFromCls: jest.fn(),
}));

const snapshot = getActorSnapshotFromCls as jest.MockedFunction<typeof getActorSnapshotFromCls>;

/** A handler function carrying (or not) the per-user opt-in metadata. */
function handlerWithOptIn(optedIn: boolean): () => void {
  const handler = (): void => undefined;

  if (optedIn) {
    Reflect.defineMetadata(PER_USER_THROTTLE_KEY, true, handler);
  }

  return handler;
}

function contextFor(handler: () => void): ExecutionContext {
  class DummyController {}

  return {
    getHandler: () => handler,
    getClass: () => DummyController,
  } as unknown as ExecutionContext;
}

afterEach(() => jest.clearAllMocks());

describe('getUserTracker', () => {
  it('tracks by the authenticated user id from CLS', () => {
    snapshot.mockReturnValue({ actor: { kind: 'user', userId: 'user-9' } });

    expect(getUserTracker({}, contextFor(handlerWithOptIn(true)))).toBe('user-9');
  });

  it('resolves the api-key owner id', () => {
    snapshot.mockReturnValue({ actor: { kind: 'apiKey', apiKeyId: 'key-1', userId: 'owner-3' } });

    expect(getUserTracker({}, contextFor(handlerWithOptIn(true)))).toBe('owner-3');
  });

  it('falls back to an empty tracker when no actor is present', () => {
    snapshot.mockReturnValue({});

    expect(getUserTracker({}, contextFor(handlerWithOptIn(true)))).toBe('');
  });
});

describe('skipUserThrottle', () => {
  it('skips routes that did not opt in', () => {
    snapshot.mockReturnValue({ actor: { kind: 'user', userId: 'user-9' } });

    expect(skipUserThrottle(contextFor(handlerWithOptIn(false)))).toBe(true);
  });

  it('applies to opted-in routes with an authenticated user', () => {
    snapshot.mockReturnValue({ actor: { kind: 'user', userId: 'user-9' } });

    expect(skipUserThrottle(contextFor(handlerWithOptIn(true)))).toBe(false);
  });

  it('skips opted-in routes when no user is present (IP tier + AuthGuard handle it)', () => {
    snapshot.mockReturnValue({});

    expect(skipUserThrottle(contextFor(handlerWithOptIn(true)))).toBe(true);
  });

  it('skips opted-in routes for actors that carry no user id (e.g. system)', () => {
    snapshot.mockReturnValue({ actor: { kind: 'system', reason: 'scheduled-sweep' } });

    expect(skipUserThrottle(contextFor(handlerWithOptIn(true)))).toBe(true);
  });
});

describe('createUserThrottler', () => {
  it('registers under the shared user-throttler name with the CLS tracker and skip guard', () => {
    const throttler = createUserThrottler(hours(1));

    expect(throttler.name).toBe(USER_THROTTLER_NAME);
    expect(throttler.ttl).toBe(3_600_000);
    expect(throttler.getTracker).toBe(getUserTracker);
    expect(throttler.skipIf).toBe(skipUserThrottle);
    // Sentinel limit — never enforced (skipped off-route, overridden on-route).
    expect(throttler.limit).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('FeedbackSubmissionThrottle', () => {
  // `@Throttle` stores each tier's options under `'THROTTLER:TTL' + name`.
  // That constant is internal to `@nestjs/throttler` (not re-exported from its
  // index), so it is spelled out here rather than imported. If a future version
  // changes it, these specs fail loudly — which is the outcome we want, since
  // the decorator's forwarding would then need re-verifying anyway.
  const throttlerTtl = (name: string, handler: object): unknown => Reflect.getMetadata(`THROTTLER:TTL${name}`, handler);
  const throttlerLimit = (name: string, handler: object): unknown =>
    Reflect.getMetadata(`THROTTLER:LIMIT${name}`, handler);

  class Target {
    @FeedbackSubmissionThrottle({
      userLimit: FEEDBACK_USER_THROTTLE_LIMIT,
      ipLimit: FEEDBACK_IP_THROTTLE_LIMIT,
      ttlMs: FEEDBACK_THROTTLE_TTL_MS,
    })
    handle(): void {
      return undefined;
    }
  }

  it('marks the route as opted into the per-user tier', () => {
    expect(Reflect.getMetadata(PER_USER_THROTTLE_KEY, Target.prototype.handle)).toBe(true);
  });

  it('applies the documented hourly window to both tiers', () => {
    // The policy is documented as 30/user/hr + 100/IP/hr (#45). It was in fact
    // 3.6 SECONDS: `FEEDBACK_THROTTLE_TTL_SECONDS = 3600` was forwarded into a
    // milliseconds field, so the ceiling was unreachable and the tier read as
    // enforced while doing nothing (#293). Asserted against the shipped
    // constant rather than a restated literal — restating it here is how the
    // original defect would have survived its own regression test.
    expect(FEEDBACK_THROTTLE_TTL_MS).toBe(3_600_000);
    expect(throttlerTtl(USER_THROTTLER_NAME, Target.prototype.handle)).toBe(3_600_000);
    expect(throttlerTtl(DEFAULT_THROTTLER_NAME, Target.prototype.handle)).toBe(3_600_000);
  });

  it('keeps the two tiers independent in their limits', () => {
    expect(throttlerLimit(USER_THROTTLER_NAME, Target.prototype.handle)).toBe(FEEDBACK_USER_THROTTLE_LIMIT);
    expect(throttlerLimit(DEFAULT_THROTTLER_NAME, Target.prototype.handle)).toBe(FEEDBACK_IP_THROTTLE_LIMIT);
  });
});
