import type { Permission } from '@bge/database';
import { Action, ResourceType, RiskLevel } from '@bge/database';
import { catalogPermission, makePermission } from '@bge/testing';
import { Logger } from '@nestjs/common';
import { AbilityFactory } from '../ability.factory';
import type {
  ApiKeyScopeWithPermission,
  ApikeyWithScopes,
  RoleWithPermissions,
  UserPermissionWithPermission,
  UserWithRoles,
} from '../interfaces';
import { acceptsPin, API_KEY_PINNABLE_TYPES, grantablePermissions, mayKeyHold } from './grantable';

// Which permissions an API key may hold: its owner holds it now, it renders in
// at least one context where the owner holds it, and it is an allow (#1417).
describe('API_KEY_PINNABLE_TYPES (#1417)', () => {
  // A type joins the list when its routes hold a key to its pin and an e2e
  // covers that, so a change here is a reviewed decision, not a drive-by.
  it('pins the pinnable types', () => {
    expect([...API_KEY_PINNABLE_TYPES].sort()).toEqual([
      'HouseholdBan',
      'Job',
      'Notification',
      'Plugin',
      'User',
      'WebhookSubscription',
    ]);
  });
});

describe('acceptsPin (#1417)', () => {
  it('accepts a pin on a pinnable type', () => {
    expect(acceptsPin({ action: Action.read, subject: ResourceType.WebhookSubscription })).toBe(true);
  });

  it('refuses a pin on a type that is not on the list', () => {
    expect(acceptsPin({ action: Action.read, subject: ResourceType.HouseholdPlugin })).toBe(false);
    expect(acceptsPin({ action: Action.manage, subject: 'all' })).toBe(false);
  });

  // No row exists yet for a create to be pinned to.
  it('refuses a pin on a create permission, even on a pinnable type', () => {
    const createWebhookSubscription = makePermission({
      slug: 'create:webhook_subscription',
      action: Action.create,
      subject: ResourceType.WebhookSubscription,
    });

    expect(acceptsPin(createWebhookSubscription)).toBe(false);
  });
});

describe('grantablePermissions and mayKeyHold (#1417)', () => {
  const readGame = makePermission({ id: 'perm-read-game', slug: 'read:game', subject: ResourceType.Game });
  const readHousehold = makePermission({
    id: 'perm-read-household',
    slug: 'read:household',
    subject: ResourceType.Household,
    conditions: { id: '{{ householdId }}' },
  });
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
    subject: ResourceType.Game,
    conditions: { reach: 'Private' },
    inverted: true,
  });
  // A direct grant renders with the user alone, so a template naming
  // householdId can't be built for it.
  const banInHousehold = makePermission({
    id: 'perm-ban-in-household',
    slug: 'create:household_ban',
    action: Action.create,
    subject: ResourceType.HouseholdBan,
    conditions: { householdId: '{{ householdId }}' },
  });
  const notHeld = makePermission({ id: 'perm-not-held', slug: 'read:platform', subject: ResourceType.Platform });

  const owner = makeOwner({
    roles: [makeRole('User', [readGame, denyPrivateGames])],
    householdMember: [{ householdId: 'hh-A', role: makeRole('HouseholdMember', [readHousehold, readGame]) }],
    permissions: [makeGrant(readOwnNotification), makeGrant(banInHousehold)],
  });

  const fixturePermissions = [readGame, readHousehold, readOwnNotification, denyPrivateGames, banInHousehold, notHeld];
  const fixtureIds = fixturePermissions.map(({ id }) => id);

  it('offers a permission held through a server role', () => {
    const owner = makeOwner({ roles: [makeRole('User', [readGame])] });

    expect(grantablePermissions(owner)).toEqual([
      { id: readGame.id, slug: 'read:game', riskLevel: RiskLevel.Low, pinnable: false },
    ]);
    expect(mayKeyHold(owner, readGame.id)).toBe(true);
  });

  it('offers a permission held through a membership', () => {
    const owner = makeOwner({
      householdMember: [{ householdId: 'hh-A', role: makeRole('HouseholdMember', [readHousehold]) }],
    });

    expect(grantablePermissions(owner)).toEqual([
      { id: readHousehold.id, slug: 'read:household', riskLevel: RiskLevel.Low, pinnable: false },
    ]);
    expect(mayKeyHold(owner, readHousehold.id)).toBe(true);
  });

  it('offers a permission held through a direct grant', () => {
    const owner = makeOwner({ permissions: [makeGrant(readOwnNotification)] });

    expect(grantablePermissions(owner)).toEqual([
      { id: readOwnNotification.id, slug: 'read:notification:own', riskLevel: RiskLevel.Medium, pinnable: true },
    ]);
    expect(mayKeyHold(owner, readOwnNotification.id)).toBe(true);
  });

  it('lists a permission held through two contexts once', () => {
    const listed = grantablePermissions(owner).filter(({ id }) => id === readGame.id);

    expect(listed).toHaveLength(1);
  });

  it('lists every grantable permission once, sorted by slug', () => {
    expect(grantablePermissions(owner).map(({ slug }) => slug)).toEqual([
      'read:game',
      'read:household',
      'read:notification:own',
    ]);
  });

  // A denial only narrows; a key holding one is refused for now.
  it('refuses a denial', () => {
    expect(mayKeyHold(owner, denyPrivateGames.id)).toBe(false);
    expect(grantablePermissions(owner).map(({ id }) => id)).not.toContain(denyPrivateGames.id);
  });

  it('refuses a direct grant whose template names householdId', () => {
    expect(mayKeyHold(owner, banInHousehold.id)).toBe(false);
    expect(grantablePermissions(owner).map(({ id }) => id)).not.toContain(banInHousehold.id);
  });

  // The same template held through a membership renders, so it is offered.
  it('offers that template where a membership supplies householdId', () => {
    const member = makeOwner({
      householdMember: [{ householdId: 'hh-A', role: makeRole('HouseholdAdmin', [banInHousehold]) }],
      permissions: [makeGrant(banInHousehold)],
    });

    expect(grantablePermissions(member)).toEqual([
      { id: banInHousehold.id, slug: 'create:household_ban', riskLevel: RiskLevel.Low, pinnable: false },
    ]);
  });

  it("refuses a permission the owner doesn't hold", () => {
    expect(mayKeyHold(owner, notHeld.id)).toBe(false);
  });

  // The loader leaves retired rows out; a stale graph must not offer one.
  it('refuses a retired permission a stale graph still carries', () => {
    const retired = makePermission({ id: 'perm-retired', retiredAt: new Date('2026-11-01T00:00:00.000Z') });
    const owner = makeOwner({ roles: [makeRole('User', [retired])], permissions: [makeGrant(retired)] });

    expect(mayKeyHold(owner, retired.id)).toBe(false);
    expect(grantablePermissions(owner)).toEqual([]);
  });

  // An Admin-like owner holds `read:public_content` (subject 'all') through a
  // server role; a direct grant never carries an 'all' permission (#1417).
  it("offers a permission on 'all' held through a server role, not through a direct grant", () => {
    const readPublicContent = makePermission({
      id: 'perm-read-public-content',
      slug: 'read:public_content',
      action: Action.read,
      subject: 'all',
    });
    const viaRole = makeOwner({ roles: [makeRole('Admin', [readPublicContent])] });
    const viaGrant = makeOwner({ permissions: [makeGrant(readPublicContent)] });

    expect(grantablePermissions(viaRole)).toEqual([
      { id: readPublicContent.id, slug: 'read:public_content', riskLevel: RiskLevel.Low, pinnable: false },
    ]);
    expect(mayKeyHold(viaRole, readPublicContent.id)).toBe(true);
    expect(grantablePermissions(viaGrant)).toEqual([]);
    expect(mayKeyHold(viaGrant, readPublicContent.id)).toBe(false);
  });

  // Risk adds friction at create and excludes nothing.
  it('offers a Critical permission with its riskLevel', () => {
    const manageAll = catalogPermission('manage:all');
    const serverOwner = makeOwner({ roles: [makeRole('Owner', [manageAll])] });

    expect(grantablePermissions(serverOwner)).toEqual([
      { id: manageAll.id, slug: 'manage:all', riskLevel: RiskLevel.Critical, pinnable: false },
    ]);
  });

  it('mayKeyHold agrees with grantablePermissions for every permission in the fixture', () => {
    const listed = new Set(grantablePermissions(owner).map(({ id }) => id));

    for (const id of fixtureIds) {
      expect({ id, mayKeyHold: mayKeyHold(owner, id) }).toEqual({ id, mayKeyHold: listed.has(id) });
    }
  });

  // The list and the factory read one buildability decision, so a key scope
  // the list offers always builds a rule, and one it refuses never does.
  describe('against the factory', () => {
    let warn: jest.SpyInstance;

    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => warn.mockRestore());

    it('a permission is grantable when the factory builds at least one allow rule for it', () => {
      const factory = new AbilityFactory();

      for (const permission of fixturePermissions) {
        const builds = factory.createForApiKey(owner, keyScopedTo(permission)).rules.some(({ inverted }) => !inverted);

        expect({ id: permission.id, mayKeyHold: mayKeyHold(owner, permission.id) }).toEqual({
          id: permission.id,
          mayKeyHold: builds,
        });
      }

      expect(factory.createForApiKey(owner, keyScopedTo(notHeld)).rules).toEqual([]);
    });
  });
});

function makeOwner(overrides: Partial<UserWithRoles> = {}): UserWithRoles {
  return {
    id: 'owner-1',
    roles: [],
    householdMember: [],
    eventsAttended: [],
    permissions: [],
    ...overrides,
  };
}

function makeRole(name: string, permissions: Permission[]): RoleWithPermissions {
  return { role: { name, permissions: permissions.map((permission) => ({ permission })) } };
}

function makeGrant(permission: Permission): UserPermissionWithPermission {
  const { id, action, subject, conditions, fields, inverted, slug, riskLevel, retiredAt } = permission;

  return {
    inverted: null,
    resourceType: ResourceType.Household,
    resourceId: null,
    expiresAt: null,
    permission: { id, action, subject, conditions, fields, inverted, slug, riskLevel, retiredAt },
  };
}

function keyScopedTo(permission: Permission): ApikeyWithScopes {
  const { id, action, subject, conditions, fields, inverted } = permission;
  const scope: ApiKeyScopeWithPermission = {
    id: `scope-${id}`,
    apiKeyId: 'key-1',
    permissionId: id,
    resourceType: ResourceType.Game,
    resourceId: null,
    createdAt: new Date(),
    permission: { id, action, subject, conditions, fields, inverted },
  };

  return {
    id: 'key-1',
    key: 'bge_test_key',
    referenceId: 'owner-1',
    configId: 'config-1',
    permissions: null,
    name: 'Test Key',
    start: null,
    prefix: null,
    enabled: true,
    refillInterval: null,
    refillAmount: null,
    lastRefillAt: null,
    rateLimitEnabled: true,
    rateLimitTimeWindow: 86400000,
    rateLimitMax: 10,
    requestCount: 0,
    remaining: null,
    lastRequest: null,
    metadata: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    scopes: [scope],
  };
}
