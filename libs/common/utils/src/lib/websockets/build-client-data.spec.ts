import type { UserSession } from '@thallesp/nestjs-better-auth';
import { buildWsClientData } from './build-client-data';

const buildSession = (overrides: { userId?: string; isAnonymous?: boolean }): UserSession =>
  ({
    user: {
      id: overrides.userId ?? 'user-1',
      isAnonymous: overrides.isAnonymous ?? false,
    },
    session: {
      id: 'sess-1',
      userId: overrides.userId ?? 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
    },
  }) as unknown as UserSession;

describe('buildWsClientData', () => {
  it('builds a user actor payload for a registered (non-anonymous) session', () => {
    const session = buildSession({ userId: 'user-42' });
    const headers: Record<string, string> = {};

    const data = buildWsClientData(session, headers);

    expect(data).toEqual({
      userId: 'user-42',
      actor: { kind: 'user', userId: 'user-42' },
      correlationId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
    });
  });

  it('returns null for anonymous sessions (Phase 1: anon not permitted over WS)', () => {
    const session = buildSession({ userId: 'anon-1', isAnonymous: true });

    expect(buildWsClientData(session, {})).toBeNull();
  });

  it('uses traceparent trace_id as correlation id when valid', () => {
    const session = buildSession({});
    const data = buildWsClientData(session, {
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });

    expect(data?.correlationId).toBe('0af7651916cd43dd8448eb211c80319c');
  });

  it('falls back to x-correlation-id when traceparent is invalid', () => {
    const session = buildSession({});
    const data = buildWsClientData(session, {
      traceparent: 'malformed',
      'x-correlation-id': 'corr-handshake',
    });

    expect(data?.correlationId).toBe('corr-handshake');
  });

  it('generates a UUID when neither header is present', () => {
    const session = buildSession({});
    const data = buildWsClientData(session, {});

    expect(data?.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('handles undefined isAnonymous as non-anonymous (anonymous plugin disabled)', () => {
    const session = {
      user: { id: 'user-7' /* no isAnonymous */ },
      session: {
        id: 'sess',
        userId: 'user-7',
        expiresAt: new Date(Date.now() + 60_000),
      },
    } as unknown as UserSession;

    const data = buildWsClientData(session, {});

    expect(data).not.toBeNull();
    expect(data?.actor.kind).toBe('user');
  });
});
