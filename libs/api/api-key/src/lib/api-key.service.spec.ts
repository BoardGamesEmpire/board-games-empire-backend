import type { AuditContextService } from '@bge/actor-context';
import type { AuthService, CreatedApiKey } from '@bge/auth';
import type { DatabaseService, Permission } from '@bge/database';
import { Action, ResourceType, RiskLevel } from '@bge/database';
import { CodedHttpException } from '@bge/i18n';
import type { PermissionsService, UserWithRoles } from '@bge/permissions';
import type { MockDatabaseService } from '@bge/testing';
import { createMockDatabaseService, makePermission, rawQueryText, unwrapTransaction } from '@bge/testing';
import { Http } from '@status/codes';
import { ApiKeyService } from './api-key.service';

const USER_ID = 'user-1';
const KEY_ID = 'key-1';
const NOW = Date.parse('2026-11-23T12:00:00Z');
const DAY_SECONDS = 86_400;
const DAY_MS = DAY_SECONDS * 1000;

describe('ApiKeyService (#1417)', () => {
  const readGame = makePermission({ id: 'perm-read-game', slug: 'read:game', subject: ResourceType.Game });
  const readOwnNotification = makePermission({
    id: 'perm-read-notification',
    slug: 'read:notification:own',
    subject: ResourceType.Notification,
    conditions: { userId: '{{ user.id }}' },
    riskLevel: RiskLevel.Medium,
  });
  const denyPrivateGames = makePermission({
    id: 'perm-deny-private-games',
    slug: 'read:game:deny_private',
    action: Action.read,
    subject: ResourceType.Game,
    inverted: true,
  });
  const manageSafeHttpPolicy = makePermission({
    id: 'perm-manage-safe-http-policy',
    slug: 'manage:safe_http_policy',
    action: Action.manage,
    subject: ResourceType.SafeHttpPolicy,
    riskLevel: RiskLevel.Critical,
  });
  const notHeld = makePermission({ id: 'perm-read-platform', slug: 'read:platform', subject: ResourceType.Platform });

  const created: CreatedApiKey = {
    id: KEY_ID,
    key: 'bge_the-secret',
    start: 'bge_th',
    expiresAt: new Date(NOW + 90 * DAY_MS),
  };

  let db: MockDatabaseService;
  let permissions: jest.Mocked<Pick<PermissionsService, 'getUserRoleGraph' | 'invalidateApiKey'>>;
  let auth: jest.Mocked<Pick<AuthService, 'createApiKey'>>;
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getSessionSignedInAt'>>;
  let service: ApiKeyService;

  beforeEach(() => {
    db = createMockDatabaseService();
    db.apiKeyScope.findMany.mockResolvedValue([]);
    db.apiKeyScope.deleteMany.mockResolvedValue({ count: 0 });
    db.apiKeyScope.createMany.mockResolvedValue({ count: 0 });
    unwrapTransaction(db);
    db.permission.findMany.mockResolvedValue([readGame, readOwnNotification, manageSafeHttpPolicy, notHeld]);
    db.apikey.findUniqueOrThrow.mockResolvedValue(keyRow() as never);

    permissions = {
      getUserRoleGraph: jest
        .fn()
        .mockResolvedValue(graphOf(USER_ID, [readGame, readOwnNotification, manageSafeHttpPolicy])),
      invalidateApiKey: jest.fn().mockResolvedValue(undefined),
    };
    auth = { createApiKey: jest.fn().mockResolvedValue(created) };
    auditContext = { getSessionSignedInAt: jest.fn().mockReturnValue(new Date(NOW - 60_000)) };

    service = new ApiKeyService(
      permissions as unknown as PermissionsService,
      db as unknown as DatabaseService,
      auth as unknown as AuthService,
      auditContext as unknown as AuditContextService,
    );
    // The service reads the time through its clock, so the spec fixes it.
    Object.assign(service, { now: () => NOW });
  });

  describe('grantableFor', () => {
    it("reads the signed-in user's graph and returns its grantable permissions", async () => {
      permissions.getUserRoleGraph.mockResolvedValue(
        graphOf('user-1', [readOwnNotification, readGame, denyPrivateGames]),
      );

      await expect(service.grantableFor('user-1')).resolves.toEqual([
        { id: readGame.id, slug: 'read:game', riskLevel: RiskLevel.Low, pinnable: false },
        { id: readOwnNotification.id, slug: 'read:notification:own', riskLevel: RiskLevel.Medium, pinnable: true },
      ]);
      expect(permissions.getUserRoleGraph).toHaveBeenCalledWith('user-1');
    });

    // A deleted user has no graph, so there is nothing a key could hold.
    it('a missing graph gives an empty list', async () => {
      permissions.getUserRoleGraph.mockResolvedValue(null);

      await expect(service.grantableFor('user-1')).resolves.toEqual([]);
    });
  });

  describe('create (#1418)', () => {
    it('writes the key scope rows after better-auth creates the key, which expires in 90 days by default (#1418)', async () => {
      // The shared db mock keeps its own call counter, so order is tracked by hand.
      const order: string[] = [];
      auth.createApiKey.mockImplementation((async () => {
        order.push('createApiKey');

        return created;
      }) as never);
      db.apiKeyScope.createMany.mockImplementation((async () => {
        order.push('createMany');

        return { count: 2 };
      }) as never);

      const result = await service.create(USER_ID, {
        name: 'CI',
        scopes: [{ slug: 'read:game' }, { slug: 'read:notification:own', resourceId: 'notification-1' }],
      });

      expect(auth.createApiKey).toHaveBeenCalledWith({
        userId: USER_ID,
        name: 'CI',
        expiresInSeconds: 90 * DAY_SECONDS,
      });
      expect(db.apiKeyScope.createMany).toHaveBeenCalledWith({
        data: [
          { apiKeyId: KEY_ID, permissionId: readGame.id, resourceType: ResourceType.Game, resourceId: null },
          {
            apiKeyId: KEY_ID,
            permissionId: readOwnNotification.id,
            resourceType: ResourceType.Notification,
            resourceId: 'notification-1',
          },
        ],
      });
      expect(order).toEqual(['createApiKey', 'createMany']);
      expect(result).toEqual({ apiKey: keyView(), secret: 'bge_the-secret' });
    });

    it('passes the expiry the request names to better-auth, in seconds (#1418)', async () => {
      await service.create(USER_ID, { name: 'CI', expiresInDays: 365 });

      expect(auth.createApiKey).toHaveBeenCalledWith({
        userId: USER_ID,
        name: 'CI',
        expiresInSeconds: 365 * DAY_SECONDS,
      });
    });

    // better-auth writes the key outside any Prisma transaction, so a failed
    // scope write leaves a key with no key scopes unless the service removes it.
    it('deletes the key when the key scope transaction fails, and rethrows (#1418)', async () => {
      // @bge/testing's mocks keep their own call counter, so the order is recorded here.
      const order: string[] = [];
      const failure = new Error('connection lost');
      db.apiKeyScope.createMany.mockImplementation((() => {
        order.push('write-scopes');
        return Promise.reject(failure);
      }) as never);
      db.apikey.deleteMany.mockImplementation((() => {
        order.push('delete-key');
        return Promise.resolve({ count: 1 });
      }) as never);

      await expect(service.create(USER_ID, { name: 'CI', scopes: [{ slug: 'read:game' }] })).rejects.toBe(failure);

      expect(db.apikey.deleteMany).toHaveBeenCalledWith({ where: { id: KEY_ID } });
      expect(order).toEqual(['write-scopes', 'delete-key']);
    });

    it('rethrows the key scope failure even when deleting the key fails too (#1418)', async () => {
      const failure = new Error('connection lost');
      db.apiKeyScope.createMany.mockRejectedValue(failure);
      db.apikey.deleteMany.mockRejectedValue(new Error('still down'));

      await expect(service.create(USER_ID, { name: 'CI', scopes: [{ slug: 'read:game' }] })).rejects.toBe(failure);
    });

    it('refuses both scopes and a preset with API_KEY_SCOPES_OR_PRESET before calling better-auth (#1418)', async () => {
      const error = await refusal(
        service.create(USER_ID, { name: 'CI', scopes: [{ slug: 'read:game' }], preset: 'everything' }),
      );

      expect(error.getStatus()).toBe(Http.UnprocessableEntity);
      expect(error.getResponse()).toMatchObject({ code: 'API_KEY_SCOPES_OR_PRESET' });
      expect(auth.createApiKey).not.toHaveBeenCalled();
    });

    it('refuses a slug the owner does not hold with API_KEY_SCOPE_NOT_GRANTABLE before calling better-auth (#1418)', async () => {
      const error = await refusal(service.create(USER_ID, { name: 'CI', scopes: [{ slug: 'read:platform' }] }));

      expect(error.getResponse()).toMatchObject({ code: 'API_KEY_SCOPE_NOT_GRANTABLE', slug: 'read:platform' });
      expect(auth.createApiKey).not.toHaveBeenCalled();
    });

    // A user with no graph holds nothing, so no permission is grantable.
    it('refuses every slug when the owner has no graph (#1418)', async () => {
      permissions.getUserRoleGraph.mockResolvedValue(null);

      const error = await refusal(service.create(USER_ID, { name: 'CI', scopes: [{ slug: 'read:game' }] }));

      expect(error.getResponse()).toMatchObject({ code: 'API_KEY_SCOPE_NOT_GRANTABLE', slug: 'read:game' });
      expect(auth.createApiKey).not.toHaveBeenCalled();
    });

    it('refuses an expiry outside 1 to 365 days with API_KEY_EXPIRY_OUT_OF_RANGE before calling better-auth (#1418)', async () => {
      const error = await refusal(service.create(USER_ID, { name: 'CI', expiresInDays: 366 }));

      expect(error.getResponse()).toMatchObject({ code: 'API_KEY_EXPIRY_OUT_OF_RANGE' });
      expect(auth.createApiKey).not.toHaveBeenCalled();
    });

    it('writes one unpinned key scope row per grantable permission for the everything preset (#1418)', async () => {
      await service.create(USER_ID, { name: 'CI', preset: 'everything', confirmCritical: true });

      expect(db.apiKeyScope.createMany).toHaveBeenCalledWith({
        data: [
          {
            apiKeyId: KEY_ID,
            permissionId: manageSafeHttpPolicy.id,
            resourceType: ResourceType.SafeHttpPolicy,
            resourceId: null,
          },
          { apiKeyId: KEY_ID, permissionId: readGame.id, resourceType: ResourceType.Game, resourceId: null },
          {
            apiKeyId: KEY_ID,
            permissionId: readOwnNotification.id,
            resourceType: ResourceType.Notification,
            resourceId: null,
          },
        ],
      });
    });

    it('refuses a Critical key scope without confirmCritical before calling better-auth (#1418)', async () => {
      const error = await refusal(
        service.create(USER_ID, { name: 'CI', scopes: [{ slug: 'manage:safe_http_policy' }] }),
      );

      expect(error.getStatus()).toBe(Http.UnprocessableEntity);
      expect(error.getResponse()).toMatchObject({ code: 'API_KEY_CRITICAL_NEEDS_CONFIRMATION' });
      expect(auth.createApiKey).not.toHaveBeenCalled();
    });

    // The everything preset holds every grantable permission, Critical ones included.
    it('refuses the everything preset over a Critical permission without confirmCritical (#1418)', async () => {
      const error = await refusal(service.create(USER_ID, { name: 'CI', preset: 'everything' }));

      expect(error.getResponse()).toMatchObject({ code: 'API_KEY_CRITICAL_NEEDS_CONFIRMATION' });
      expect(auth.createApiKey).not.toHaveBeenCalled();
    });

    it('refuses a confirmed Critical key scope from a session signed in a day ago with API_KEY_NEEDS_RECENT_SIGN_IN (#1418)', async () => {
      auditContext.getSessionSignedInAt.mockReturnValue(new Date(NOW - DAY_MS));

      const error = await refusal(
        service.create(USER_ID, {
          name: 'CI',
          scopes: [{ slug: 'manage:safe_http_policy' }],
          confirmCritical: true,
        }),
      );

      expect(error.getStatus()).toBe(Http.Forbidden);
      expect(error.getResponse()).toMatchObject({ code: 'API_KEY_NEEDS_RECENT_SIGN_IN' });
      expect(auth.createApiKey).not.toHaveBeenCalled();
    });

    it('creates a confirmed Critical key scope from a recent sign-in (#1418)', async () => {
      await service.create(USER_ID, {
        name: 'CI',
        scopes: [{ slug: 'manage:safe_http_policy' }],
        confirmCritical: true,
      });

      expect(auth.createApiKey).toHaveBeenCalled();
    });
  });

  describe('list (#1418)', () => {
    it("pages the owner's keys, newest first (#1418)", async () => {
      db.apikey.findMany.mockResolvedValue([keyRow()] as never);
      db.apikey.count.mockResolvedValue(3);

      await expect(service.list(USER_ID, { page: 2, pageSize: 2 })).resolves.toEqual({ rows: [keyView()], total: 3 });

      expect(db.apikey.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { referenceId: USER_ID },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: 2,
          take: 2,
        }),
      );
      expect(db.apikey.count).toHaveBeenCalledWith({ where: { referenceId: USER_ID } });
    });
  });

  describe('get (#1418)', () => {
    it("reads the owner's key (#1418)", async () => {
      db.apikey.findUnique.mockResolvedValue(keyRow() as never);

      await expect(service.get(USER_ID, KEY_ID)).resolves.toEqual(keyView());
      expect(db.apikey.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: KEY_ID, referenceId: USER_ID } }),
      );
    });

    // A missing key and another user's key answer alike.
    it("answers another user's key with API_KEY_NOT_FOUND (#1418)", async () => {
      db.apikey.findUnique.mockResolvedValue(null);

      const error = await refusal(service.get(USER_ID, KEY_ID));

      expect(error.getStatus()).toBe(Http.NotFound);
      expect(error.getResponse()).toMatchObject({ code: 'API_KEY_NOT_FOUND' });
    });
  });

  describe('update (#1418)', () => {
    beforeEach(() => {
      db.$queryRaw.mockResolvedValue([{ id: KEY_ID }] as never);
      db.apikey.update.mockResolvedValue(keyRow() as never);
    });

    // Two edits at once must not merge their key scope lists, and the Critical
    // check must judge the scopes the key holds once no other edit can change them.
    it('locks the row before reading the current key scopes (#1418)', async () => {
      const order: string[] = [];
      db.$queryRaw.mockImplementation((() => {
        order.push('lock');
        return Promise.resolve([{ id: KEY_ID }]);
      }) as never);
      db.apiKeyScope.findMany.mockImplementation((() => {
        order.push('read-scopes');
        return Promise.resolve([]);
      }) as never);
      db.apiKeyScope.deleteMany.mockImplementation((() => {
        order.push('delete-scopes');
        return Promise.resolve({ count: 0 });
      }) as never);
      db.apiKeyScope.createMany.mockImplementation((() => {
        order.push('write-scopes');
        return Promise.resolve({ count: 1 });
      }) as never);

      await service.update(USER_ID, KEY_ID, { scopes: [{ slug: 'read:game' }] });

      expect(order).toEqual(['lock', 'read-scopes', 'delete-scopes', 'write-scopes']);
      const [[lock]] = db.$queryRaw.mock.calls;
      expect(rawQueryText(lock)).toBe('SELECT id FROM apikeys WHERE id = ? AND reference_id = ? FOR UPDATE');
      expect(lock).toMatchObject({ values: [KEY_ID, USER_ID] });
    });

    it("replaces the key scopes and evicts the key's cached scope graph after the commit (#1418)", async () => {
      const order: string[] = [];
      db.apiKeyScope.findMany.mockResolvedValue([{ permissionId: readGame.id }] as never);
      db.$transaction.mockImplementation((async (write: (tx: MockDatabaseService) => Promise<unknown>) => {
        const result = await write(db);
        order.push('commit');
        return result;
      }) as never);
      permissions.invalidateApiKey.mockImplementation(async () => {
        order.push('evict');
      });

      await expect(
        service.update(USER_ID, KEY_ID, { scopes: [{ slug: 'read:notification:own', resourceId: 'notification-1' }] }),
      ).resolves.toEqual(keyView());

      expect(db.apiKeyScope.deleteMany).toHaveBeenCalledWith({ where: { apiKeyId: KEY_ID } });
      expect(db.apiKeyScope.createMany).toHaveBeenCalledWith({
        data: [
          {
            apiKeyId: KEY_ID,
            permissionId: readOwnNotification.id,
            resourceType: ResourceType.Notification,
            resourceId: 'notification-1',
          },
        ],
      });
      expect(permissions.invalidateApiKey).toHaveBeenCalledWith(KEY_ID);
      expect(order).toEqual(['commit', 'evict']);
    });

    // A key may hold no key scopes; it is denied everywhere.
    it('accepts an empty key scope list (#1418)', async () => {
      await service.update(USER_ID, KEY_ID, { scopes: [] });

      expect(db.apiKeyScope.deleteMany).toHaveBeenCalledWith({ where: { apiKeyId: KEY_ID } });
      expect(db.apiKeyScope.createMany).toHaveBeenCalledWith({ data: [] });
      expect(permissions.invalidateApiKey).toHaveBeenCalledWith(KEY_ID);
    });

    it('evicts nothing when only the name changes (#1418)', async () => {
      await service.update(USER_ID, KEY_ID, { name: 'renamed' });

      expect(db.apikey.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: KEY_ID }, data: { name: 'renamed' } }),
      );
      expect(db.apiKeyScope.deleteMany).not.toHaveBeenCalled();
      expect(permissions.invalidateApiKey).not.toHaveBeenCalled();
    });

    it('sets the expiry that many days from now, and evicts nothing (#1418)', async () => {
      await service.update(USER_ID, KEY_ID, { expiresInDays: 7 });

      expect(db.apikey.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { expiresAt: new Date(NOW + 7 * DAY_MS) } }),
      );
      expect(permissions.invalidateApiKey).not.toHaveBeenCalled();
    });

    it('refuses an expiry outside 1 to 365 days before opening the transaction (#1418)', async () => {
      const error = await refusal(service.update(USER_ID, KEY_ID, { expiresInDays: 0 }));

      expect(error.getResponse()).toMatchObject({ code: 'API_KEY_EXPIRY_OUT_OF_RANGE' });
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('disabling the key evicts its cached scope graph (#1418)', async () => {
      await service.update(USER_ID, KEY_ID, { enabled: false });

      expect(db.apikey.update).toHaveBeenCalledWith(expect.objectContaining({ data: { enabled: false } }));
      expect(permissions.invalidateApiKey).toHaveBeenCalledWith(KEY_ID);
    });

    // An empty edit answers the key as it is, so another user's key still answers 404.
    it.each([
      ['an empty body', {}],
      ['confirmCritical alone', { confirmCritical: true }],
    ])('with %s changes nothing and evicts nothing (#1418)', async (_label, input) => {
      db.apikey.findUnique.mockResolvedValue(keyRow() as never);

      await expect(service.update(USER_ID, KEY_ID, input)).resolves.toEqual(keyView());

      expect(db.apikey.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: KEY_ID, referenceId: USER_ID } }),
      );
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.apikey.update).not.toHaveBeenCalled();
      expect(permissions.invalidateApiKey).not.toHaveBeenCalled();
    });

    it('needs a recent sign-in to add a Critical permission (#1418)', async () => {
      auditContext.getSessionSignedInAt.mockReturnValue(null);

      const error = await refusal(
        service.update(USER_ID, KEY_ID, { scopes: [{ slug: 'manage:safe_http_policy' }], confirmCritical: true }),
      );

      expect(error.getResponse()).toMatchObject({ code: 'API_KEY_NEEDS_RECENT_SIGN_IN' });
      expect(db.apiKeyScope.deleteMany).not.toHaveBeenCalled();
      expect(permissions.invalidateApiKey).not.toHaveBeenCalled();
    });

    it('refuses adding a Critical permission without confirmCritical, before any scope write (#1418)', async () => {
      const error = await refusal(service.update(USER_ID, KEY_ID, { scopes: [{ slug: 'manage:safe_http_policy' }] }));

      expect(error.getResponse()).toMatchObject({ code: 'API_KEY_CRITICAL_NEEDS_CONFIRMATION' });
      expect(db.apiKeyScope.deleteMany).not.toHaveBeenCalled();
      expect(db.apiKeyScope.createMany).not.toHaveBeenCalled();
      expect(permissions.invalidateApiKey).not.toHaveBeenCalled();
    });

    // Keeping a Critical permission adds nothing, so nothing is asked again.
    it('keeps a Critical permission the key holds without a confirmation or a recent sign-in (#1418)', async () => {
      auditContext.getSessionSignedInAt.mockReturnValue(null);
      db.apiKeyScope.findMany.mockResolvedValue([{ permissionId: manageSafeHttpPolicy.id }] as never);

      await service.update(USER_ID, KEY_ID, { scopes: [{ slug: 'manage:safe_http_policy' }, { slug: 'read:game' }] });

      expect(db.apiKeyScope.createMany).toHaveBeenCalled();
      expect(permissions.invalidateApiKey).toHaveBeenCalledWith(KEY_ID);
    });

    it("answers another user's key with API_KEY_NOT_FOUND and writes nothing (#1418)", async () => {
      db.$queryRaw.mockResolvedValue([] as never);

      const error = await refusal(service.update(USER_ID, KEY_ID, { name: 'renamed', scopes: [] }));

      expect(error.getStatus()).toBe(Http.NotFound);
      expect(error.getResponse()).toMatchObject({ code: 'API_KEY_NOT_FOUND' });
      expect(db.apiKeyScope.deleteMany).not.toHaveBeenCalled();
      expect(db.apikey.update).not.toHaveBeenCalled();
      expect(permissions.invalidateApiKey).not.toHaveBeenCalled();
    });
  });

  describe('remove (#1418)', () => {
    it("deletes the owner's key and evicts its cached scope graph (#1418)", async () => {
      db.apikey.deleteMany.mockResolvedValue({ count: 1 });

      await service.remove(USER_ID, KEY_ID);

      expect(db.apikey.deleteMany).toHaveBeenCalledWith({ where: { id: KEY_ID, referenceId: USER_ID } });
      expect(permissions.invalidateApiKey).toHaveBeenCalledWith(KEY_ID);
    });

    it("answers another user's key with API_KEY_NOT_FOUND and evicts nothing (#1418)", async () => {
      db.apikey.deleteMany.mockResolvedValue({ count: 0 });

      const error = await refusal(service.remove(USER_ID, KEY_ID));

      expect(error.getStatus()).toBe(Http.NotFound);
      expect(error.getResponse()).toMatchObject({ code: 'API_KEY_NOT_FOUND' });
      expect(permissions.invalidateApiKey).not.toHaveBeenCalled();
    });
  });

  describe('current (#1418)', () => {
    it('reports the whole seconds left until the key expires (#1418)', async () => {
      db.apikey.findUnique.mockResolvedValue(keyRow({ expiresAt: new Date(NOW + 90_500) }) as never);

      await expect(service.current(KEY_ID)).resolves.toEqual({
        ...keyView({ expiresAt: new Date(NOW + 90_500) }),
        secondsRemaining: 90,
      });
      expect(db.apikey.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: KEY_ID } }));
    });

    it('reports 0 seconds once the key has expired (#1418)', async () => {
      db.apikey.findUnique.mockResolvedValue(keyRow({ expiresAt: new Date(NOW - 5_000) }) as never);

      await expect(service.current(KEY_ID)).resolves.toMatchObject({ secondsRemaining: 0 });
    });

    it('reports no seconds for a key with no expiry (#1418)', async () => {
      db.apikey.findUnique.mockResolvedValue(keyRow({ expiresAt: null }) as never);

      await expect(service.current(KEY_ID)).resolves.toMatchObject({ secondsRemaining: null });
    });
  });
});

interface KeyRowOverrides {
  readonly expiresAt?: Date | null;
}

/** A key row as the service selects it. */
function keyRow({ expiresAt = new Date(NOW + 90 * DAY_MS) }: KeyRowOverrides = {}) {
  return {
    id: KEY_ID,
    name: 'CI',
    start: 'bge_th',
    expiresAt,
    enabled: null,
    lastRequest: new Date(NOW - 1_000),
    createdAt: new Date(NOW - 2_000),
    scopes: [
      { resourceId: null, permission: { slug: 'read:game' } },
      { resourceId: 'notification-1', permission: { slug: 'read:notification:own' } },
    ],
  };
}

/** {@link keyRow} as the service answers it: an unset `enabled` reads as enabled, `lastRequest` as `lastUsedAt`. */
function keyView({ expiresAt = new Date(NOW + 90 * DAY_MS) }: KeyRowOverrides = {}) {
  return {
    id: KEY_ID,
    name: 'CI',
    start: 'bge_th',
    expiresAt,
    enabled: true,
    lastUsedAt: new Date(NOW - 1_000),
    createdAt: new Date(NOW - 2_000),
    scopes: [
      { slug: 'read:game', resourceId: null },
      { slug: 'read:notification:own', resourceId: 'notification-1' },
    ],
  };
}

/** A user holding `permissions` through one server role. */
function graphOf(userId: string, permissions: Permission[]): UserWithRoles {
  return {
    id: userId,
    roles: [{ role: { name: 'User', permissions: permissions.map((permission) => ({ permission })) } }],
    householdMember: [],
    eventsAttended: [],
    permissions: [],
  };
}

/** The coded refusal `pending` rejects with; anything else fails the test. */
async function refusal(pending: Promise<unknown>): Promise<CodedHttpException> {
  const error: unknown = await pending.then(
    () => undefined,
    (reason: unknown) => reason,
  );

  if (!(error instanceof CodedHttpException)) {
    throw new Error(`Expected a CodedHttpException, got ${String(error)}`);
  }

  return error;
}
