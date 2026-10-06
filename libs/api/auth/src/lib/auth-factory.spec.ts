import type { AuditContextService, SystemActorScope } from '@bge/actor-context';
import type { PrismaClient } from '@bge/database';
import { ConfigService } from '@nestjs/config';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { User } from 'better-auth/types';
import { authFactory, createUserCreatedHook } from './auth-factory';
import { UserCreatedEvent } from './events/auth.events';
import { createSettingGates } from './setting-gates';

/** better-auth-shaped user, as the `user.create.after` hook receives it. */
const makeAuthUser = (overrides: Partial<User & { isAnonymous?: boolean }> = {}): User =>
  ({
    id: 'u1',
    name: 'alice',
    email: 'alice@example.com',
    emailVerified: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }) as User;

describe('createUserCreatedHook', () => {
  let emitter: { emit: jest.Mock };
  let systemActorScope: { run: jest.Mock };
  let auditContext: { getActor: jest.Mock };

  beforeEach(() => {
    emitter = { emit: jest.fn() };
    systemActorScope = { run: jest.fn((_reason: string, fn: () => unknown) => fn()) };
    auditContext = { getActor: jest.fn().mockReturnValue(null) };
  });

  const hook = () =>
    createUserCreatedHook({
      eventEmitter: emitter as unknown as EventEmitter2,
      auditContext: auditContext as unknown as AuditContextService,
      systemActorScope: systemActorScope as unknown as SystemActorScope,
    });

  it('emits a create-shaped UserCreatedEvent with the minimal snapshot', async () => {
    await hook()(makeAuthUser());

    const [name, emitted] = emitter.emit.mock.calls[0];
    expect(name).toBe(UserCreatedEvent.eventName);
    expect(emitted).toBeInstanceOf(UserCreatedEvent);
    expect(emitted.action).toBe('create');
    expect(emitted.subjectId).toBe('u1');
    expect(emitted.before).toBeNull();
    expect(emitted.after).toEqual({ id: 'u1', username: 'alice', email: 'alice@example.com', isAnonymous: false });
    expect(emitted.initiatedAt).toEqual(new Date('2026-01-01T00:00:00Z'));
  });

  it('wraps the emission in a system actor scope when the CLS actor is null (self-signup)', async () => {
    await hook()(makeAuthUser());

    expect(systemActorScope.run).toHaveBeenCalledWith('auth:user-provisioning', expect.any(Function));
    expect(emitter.emit).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing CLS attribution when an actor is present (admin-created users)', async () => {
    auditContext.getActor.mockReturnValue({ kind: 'user', userId: 'admin-1' });

    await hook()(makeAuthUser());

    expect(systemActorScope.run).not.toHaveBeenCalled();
    expect(emitter.emit).toHaveBeenCalledTimes(1);
  });

  it('flags users created by the anonymous plugin', async () => {
    await hook()(makeAuthUser({ isAnonymous: true }));

    const [, emitted] = emitter.emit.mock.calls[0];
    expect(emitted.after).toEqual(expect.objectContaining({ isAnonymous: true }));
  });

  it('rejects when no EventEmitter2 was provided to the factory', async () => {
    const bare = createUserCreatedHook({});

    await expect(bare(makeAuthUser())).rejects.toThrow('EventEmitter2 not provided to authFactory');
  });
});

/**
 * The password-reset switch refuses a list of routes, so a reset route the
 * list does not name would finish a reset with resets switched off (#585).
 * Every password route the instance serves is pinned here as refused or as
 * not a reset. A plugin that brings one (emailOTP and phoneNumber each do),
 * or a better-auth upgrade that adds one, fails this until someone decides
 * which it is.
 */
describe('the password routes authFactory serves', () => {
  const config = new ConfigService({
    auth: {
      url: 'http://localhost:33333',
      secret: 'a-unit-test-secret-of-at-least-32-characters',
      trustedOrigins: [],
      useEmailPasswordAuth: true,
    },
  });

  const resetsOff = createSettingGates({
    readSwitches: async () => ({ allowUserRegistration: true, allowPasswordResets: false, allowUsernameChange: true }),
    readUsername: async () => null,
    render: (key) => key,
  });

  it('are each refused while resets are off, or are not resets', async () => {
    const auth = authFactory({} as PrismaClient, config);
    // Server-only functions, such as `setPassword`, carry no path: no route
    // reaches them.
    const paths = Object.values(auth.api)
      .map((endpoint) => (endpoint as { readonly path?: string }).path)
      .filter((path): path is string => path?.includes('password') === true);

    const outcomes: Record<string, string> = {};
    for (const path of paths) {
      outcomes[path] = await resetsOff.beforeRoute({ path }).then(
        () => 'allowed',
        (error: { body?: { code?: string } }) => error.body?.code ?? 'thrown',
      );
    }

    expect(outcomes).toEqual({
      '/request-password-reset': 'PASSWORD_RESET_DISABLED',
      '/reset-password': 'PASSWORD_RESET_DISABLED',
      // Not resets: a signed-in change, an admin's set, a check of the current
      // password, and the GET a reset mail links to, which only redirects to
      // the client with the token.
      '/change-password': 'allowed',
      '/admin/set-user-password': 'allowed',
      '/verify-password': 'allowed',
      '/reset-password/:token': 'allowed',
    });
  });
});
