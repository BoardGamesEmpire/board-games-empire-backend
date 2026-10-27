import type { AuditContextService, SystemActorScope } from '@bge/actor-context';
import type { PrismaClient } from '@bge/database';
import { ConfigService } from '@nestjs/config';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { User } from 'better-auth/types';
import Keyv from 'keyv';
import { createHmac } from 'node:crypto';
import { authFactory, createUserCreatedHook } from './auth-factory';
import { createAuthStorage } from './auth-storage';
import { AUTH_CLIENT_IP_HEADER } from './constants';
import { UserCreatedEvent } from './events/auth.events';
import { createSettingGates } from './setting-gates';

/** The secret the instance signs cookies with. */
const SECRET = 'a-unit-test-secret-of-at-least-32-characters';

/** The configuration an instance needs to build, with email and password sign-in on. */
const config = new ConfigService({
  auth: {
    url: 'http://localhost:33333',
    secret: SECRET,
    trustedOrigins: [],
    useEmailPasswordAuth: true,
  },
});

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

/** A database where every lookup finds nothing. */
const noUsers = new Proxy(
  {},
  { get: () => new Proxy({}, { get: (_model, operation) => async () => (operation === 'findMany' ? [] : null) }) },
) as PrismaClient;

/**
 * better-auth's Prisma adapter prints its debug lines through a console logger
 * of its own, never through the `logger` option, so they would bypass pino:
 * colour codes and multi-line objects, with each query's inputs and results in
 * them (#627). Fails with the adapter's `debugLogs` on.
 */
describe("authFactory's database reads", () => {
  afterEach(() => jest.restoreAllMocks());

  it('write nothing to the console (#627)', async () => {
    const auth = authFactory(noUsers, config);
    const writes = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      jest.spyOn(console, method).mockImplementation(() => undefined),
    );

    const response = await auth.handler(
      new Request('http://localhost:33333/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.com', password: 'not-the-password' }),
      }),
    );

    expect(response.status).toBe(401);
    for (const write of writes) {
      expect(write).not.toHaveBeenCalled();
    }
  });
});

/**
 * better-auth's own rate limits run in its router, ahead of every hook, so
 * these go through a real instance's handler (#640). Each sign-in is a wrong
 * password against a database with no users, which better-auth answers with
 * 401 after hashing the password, as it would for a registered user's wrong one.
 */
describe("authFactory's sign-in rate limit", () => {
  /**
   * An instance over an in-memory store, with the limiter on. better-auth
   * turns it on only when NODE_ENV is production, which it reads once, at
   * import. The instance reads the setting from its context on every request,
   * so it is switched on there.
   */
  async function limitedAuth() {
    const auth = authFactory(noUsers, config, createAuthStorage(new Keyv({ throwOnErrors: true })));
    (await auth.$context).rateLimit.enabled = true;
    return auth;
  }

  async function signIn(
    auth: ReturnType<typeof authFactory>,
    clientIp: string,
    headers: Record<string, string> = {},
  ): Promise<number> {
    const response = await auth.handler(
      new Request('http://localhost:33333/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [AUTH_CLIENT_IP_HEADER]: clientIp, ...headers },
        body: JSON.stringify({ email: 'nobody@example.com', password: 'not-the-password' }),
      }),
    );

    return response.status;
  }

  it("refuses a client's fourth sign-in within ten seconds (#640)", async () => {
    // Fails with the store's seconds-to-milliseconds conversion removed: each
    // count would expire 10 milliseconds after it was written, before the
    // next request finished hashing.
    const auth = await limitedAuth();

    const statuses = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      statuses.push(await signIn(auth, '198.51.100.4'));
    }

    expect(statuses).toEqual([401, 401, 401, 429]);
  });

  it('counts each client on its own, by the address the api wrote (#640)', async () => {
    const auth = await limitedAuth();
    for (let attempt = 0; attempt < 3; attempt++) {
      await signIn(auth, '198.51.100.4');
    }

    await expect(signIn(auth, '203.0.113.7')).resolves.toBe(401);
  });

  it('gives a client varying X-Forwarded-For no fresh count (#640)', async () => {
    // better-auth reads X-Forwarded-For by default and believes a single
    // entry, which a client reaching the api directly writes itself.
    const auth = await limitedAuth();

    const statuses = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      statuses.push(await signIn(auth, '198.51.100.4', { 'x-forwarded-for': `192.0.2.${attempt + 1}` }));
    }

    expect(statuses).toEqual([401, 401, 401, 429]);
  });
});

/**
 * A sign-out the server could not revoke (#487). These go through a real
 * instance's handler, so the hook runs where better-auth runs it: before the
 * route, beside the settings gates.
 */
describe("authFactory's sign-out", () => {
  /** A store whose connection drops on every delete, as Redis's does when it goes away. */
  class DeletesFail extends Map<string, unknown> {
    override delete(): boolean {
      throw new Error('Connection is closed.');
    }
  }

  function authOver(store: Keyv) {
    store.on('error', () => undefined);
    return authFactory({} as PrismaClient, config, createAuthStorage(store));
  }

  /** The cookie better-auth would have set for `token`: the token, signed with the instance's secret. */
  async function sessionCookie(auth: ReturnType<typeof authFactory>, token: string): Promise<string> {
    const name = (await auth.$context).authCookies.sessionToken.name;
    const signature = createHmac('sha256', SECRET).update(token).digest('base64');
    return `${name}=${encodeURIComponent(`${token}.${signature}`)}`;
  }

  const signOut = (auth: ReturnType<typeof authFactory>, headers: Record<string, string>) =>
    auth.handler(
      new Request('http://localhost:33333/api/auth/sign-out', {
        method: 'POST',
        headers: { origin: 'http://localhost:33333', ...headers },
      }),
    );

  it('refuses with 503 and keeps the cookie when the session cannot be deleted (#487)', async () => {
    const auth = authOver(new Keyv({ store: new DeletesFail(), throwOnErrors: true }));

    const response = await signOut(auth, { cookie: await sessionCookie(auth, 'session-token') });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: 'SIGN_OUT_FAILED',
      message: 'errors.auth.sign_out_failed',
    });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a bearer sign-out it could not revoke as well (#487)', async () => {
    // The bearer plugin turns the credential into the cookie only after
    // `hooks.before` has run, so the hook reads the credential itself.
    const auth = authOver(new Keyv({ store: new DeletesFail(), throwOnErrors: true }));

    const response = await signOut(auth, { authorization: 'Bearer session-token' });

    expect(response.status).toBe(503);
  });

  it('reads a signed bearer credential as the bearer plugin does, so a forged signature names no session (#487)', async () => {
    // The plugin ignores a credential whose signature does not match, so the
    // route signs out no session for it, and the hook must not delete one.
    const auth = authOver(new Keyv({ store: new DeletesFail(), throwOnErrors: true }));
    const signed = decodeURIComponent((await sessionCookie(auth, 'session-token')).split('=').slice(1).join('='));

    const forged = await signOut(auth, { authorization: 'Bearer session-token.forged-signature' });
    const genuine = await signOut(auth, { authorization: `Bearer ${signed}` });

    expect(forged.status).toBe(200);
    expect(genuine.status).toBe(503);
  });

  it('reads a percent-encoded bearer credential as the plugin does, and a malformed one as written (#487)', async () => {
    // A client may send the signed cookie's value as it was set, encoded. The
    // plugin decodes it; one that cannot be decoded names no session.
    const auth = authOver(new Keyv({ store: new DeletesFail(), throwOnErrors: true }));
    const encoded = (await sessionCookie(auth, 'session-token')).split('=').slice(1).join('=');

    const genuine = await signOut(auth, { authorization: `Bearer ${encoded}` });
    const malformed = await signOut(auth, { authorization: 'Bearer session-token.%E0%A4%A' });

    expect(encoded).toContain('%');
    expect(genuine.status).toBe(503);
    expect(malformed.status).toBe(200);
  });

  it('signs out, deletes the session and clears the cookie when the store is up (#487)', async () => {
    const store = new Keyv({ throwOnErrors: true });
    const auth = authOver(store);
    const expiresAt = new Date(Date.now() + 60_000);
    await store.set(
      'auth_session-token',
      JSON.stringify({ session: { token: 'session-token', userId: 'u1', expiresAt }, user: { id: 'u1' } }),
      60_000,
    );
    await store.set(
      'auth_active-sessions-u1',
      JSON.stringify([{ token: 'session-token', expiresAt: expiresAt.getTime() }]),
      60_000,
    );

    const response = await signOut(auth, { cookie: await sessionCookie(auth, 'session-token') });

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toMatch(/session_token=;.*Max-Age=0/i);
    await expect(store.get('auth_session-token')).resolves.toBeUndefined();
  });

  it('lets a sign-out that names no session through, as before (#487)', async () => {
    const auth = authOver(new Keyv({ store: new DeletesFail(), throwOnErrors: true }));

    const response = await signOut(auth, {});

    expect(response.status).toBe(200);
  });
});
