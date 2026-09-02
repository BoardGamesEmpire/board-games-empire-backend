import type { UserSession } from '@thallesp/nestjs-better-auth';
import { buildWsClientData } from './build-client-data';

const CORRELATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const buildSession = (overrides: {
  userId?: string;
  isAnonymous?: boolean;
  impersonatedBy?: string | null;
}): UserSession =>
  ({
    user: {
      id: overrides.userId ?? 'user-1',
      isAnonymous: overrides.isAnonymous ?? false,
    },
    session: {
      id: 'sess-1',
      userId: overrides.userId ?? 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
      impersonatedBy: overrides.impersonatedBy ?? null,
    },
  }) as unknown as UserSession;

/** Narrows to the accepted branch, failing the test if the outcome refused. */
const accept = (outcome: ReturnType<typeof buildWsClientData>) => {
  if (!outcome.ok) {
    throw new Error(`expected an accepted outcome, got refusal: ${outcome.reason}`);
  }

  return outcome.data;
};

describe('buildWsClientData', () => {
  it('builds a user actor payload for a registered (non-anonymous) session', () => {
    const outcome = buildWsClientData(buildSession({ userId: 'user-42' }), {});

    expect(accept(outcome)).toEqual({
      userId: 'user-42',
      actor: { kind: 'user', userId: 'user-42' },
      correlationId: expect.stringMatching(CORRELATION_UUID),
    });
  });

  it('handles undefined isAnonymous as non-anonymous (anonymous plugin disabled)', () => {
    const session = {
      user: { id: 'user-7' /* no isAnonymous */ },
      session: { id: 'sess', userId: 'user-7', expiresAt: new Date(Date.now() + 60_000) },
    } as unknown as UserSession;

    expect(accept(buildWsClientData(session, {})).actor.kind).toBe('user');
  });

  it('admits an ordinary session whose impersonatedBy is null', () => {
    const outcome = buildWsClientData(buildSession({ userId: 'user-3', impersonatedBy: null }), {});

    expect(accept(outcome).actor).toEqual({ kind: 'user', userId: 'user-3' });
  });

  describe('refusals', () => {
    it('refuses anonymous sessions (Phase 1: anon not permitted over WS)', () => {
      const outcome = buildWsClientData(buildSession({ userId: 'anon-1', isAnonymous: true }), {});

      expect(outcome).toEqual({
        ok: false,
        reason: 'anonymous',
        message: 'Anonymous access not permitted',
      });
    });

    it('refuses a session with no resolvable user', () => {
      const outcome = buildWsClientData({} as unknown as UserSession, {});

      expect(outcome).toMatchObject({ ok: false, reason: 'no-user' });
    });

    /**
     * #408: an impersonated session must not mint an actor for the target
     * user. WS authenticates by bearer token, so an impersonation session's
     * token would otherwise connect and attribute every audit row to the
     * impersonated user.
     */
    it('refuses a session whose impersonatedBy is present but empty', () => {
      // Fails open if the helper reads `''` as absent.
      const outcome = buildWsClientData(buildSession({ userId: 'target-1', impersonatedBy: '' }), {});

      expect(outcome).toMatchObject({ ok: false, reason: 'impersonated' });
    });

    it('refuses an impersonated session', () => {
      const outcome = buildWsClientData(buildSession({ userId: 'target-1', impersonatedBy: 'admin-1' }), {});

      expect(outcome).toMatchObject({ ok: false, reason: 'impersonated' });
    });

    it('keeps the acting admin out of the client-facing message', () => {
      const outcome = buildWsClientData(buildSession({ userId: 'target-1', impersonatedBy: 'admin-1' }), {});

      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.message).not.toContain('admin-1');
    });

    /**
     * Ordering matters: reported as `anonymous`, the gateway's log would lose
     * the acting admin and the target entirely.
     */
    it('reports an impersonated anonymous session as impersonated, not anonymous', () => {
      const outcome = buildWsClientData(
        buildSession({ userId: 'anon-1', isAnonymous: true, impersonatedBy: 'admin-1' }),
        {},
      );

      expect(outcome).toMatchObject({ ok: false, reason: 'impersonated' });
      expect(outcome.ok === false && outcome.detail).toContain('admin-1');
    });

    it('carries the acting admin as log-only detail', () => {
      const outcome = buildWsClientData(buildSession({ userId: 'target-1', impersonatedBy: 'admin-1' }), {});

      expect(outcome.ok === false && outcome.detail).toContain('admin-1');
    });
  });

  describe('correlation id', () => {
    it('uses traceparent trace_id when valid', () => {
      const outcome = buildWsClientData(buildSession({}), {
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      });

      expect(accept(outcome).correlationId).toBe('0af7651916cd43dd8448eb211c80319c');
    });

    it('falls back to x-correlation-id when traceparent is invalid', () => {
      const outcome = buildWsClientData(buildSession({}), {
        traceparent: 'malformed',
        'x-correlation-id': 'corr-handshake',
      });

      expect(accept(outcome).correlationId).toBe('corr-handshake');
    });

    it('generates a UUID when neither header is present', () => {
      expect(accept(buildWsClientData(buildSession({}), {})).correlationId).toMatch(CORRELATION_UUID);
    });
  });
});
