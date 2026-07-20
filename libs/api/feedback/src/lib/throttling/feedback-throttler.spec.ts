import { getActorSnapshotFromCls } from '@bge/actor-context';
import type { ExecutionContext } from '@nestjs/common';
import {
  createUserThrottler,
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
    const throttler = createUserThrottler(3600);

    expect(throttler.name).toBe(USER_THROTTLER_NAME);
    expect(throttler.ttl).toBe(3600);
    expect(throttler.getTracker).toBe(getUserTracker);
    expect(throttler.skipIf).toBe(skipUserThrottle);
    // Sentinel limit — never enforced (skipped off-route, overridden on-route).
    expect(throttler.limit).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('FeedbackSubmissionThrottle', () => {
  it('marks the route as opted into the per-user tier', () => {
    class Target {
      @FeedbackSubmissionThrottle({ userLimit: 30, ipLimit: 100, ttl: 3600 })
      handle(): void {
        return undefined;
      }
    }

    expect(Reflect.getMetadata(PER_USER_THROTTLE_KEY, Target.prototype.handle)).toBe(true);
  });
});
