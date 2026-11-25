import type { Permission } from '@bge/database';
import { Action, ResourceType, RiskLevel } from '@bge/database';
import { CodedHttpException } from '@bge/i18n';
import type { RoleWithPermissions, UserPermissionWithPermission, UserWithRoles } from '@bge/permissions';
import { grantablePermissions } from '@bge/permissions';
import { catalogPermission, makePermission } from '@bge/testing';
import { Http } from '@status/codes';
import type { ResolvedScope } from './key-scope-request';
import {
  addsCritical,
  assertCriticalAllowed,
  assertExpiryInRange,
  everythingScopes,
  expiryDate,
  resolveRequestedScopes,
} from './key-scope-request';

const DAY_MS = 24 * 60 * 60 * 1000;

// The rules a key's create and edit routes apply to the key scopes, expiry and
// Critical permissions a request names (#1418).
describe('resolveRequestedScopes (#1418)', () => {
  const readGame = makePermission({ id: 'perm-read-game', slug: 'read:game', subject: ResourceType.Game });
  const readOwnNotification = makePermission({
    id: 'perm-read-notification',
    slug: 'read:notification:own',
    subject: ResourceType.Notification,
    conditions: { userId: '{{ user.id }}' },
    riskLevel: RiskLevel.Medium,
  });
  const createWebhookSubscription = makePermission({
    id: 'perm-create-webhook-subscription',
    slug: 'create:webhook_subscription',
    action: Action.create,
    subject: ResourceType.WebhookSubscription,
  });
  const managePlugin = catalogPermission('manage:plugin');
  const manageOwnWebhooks = catalogPermission('manage:webhook_subscription:own');
  const manageAll = catalogPermission('manage:all');
  const notHeld = makePermission({ id: 'perm-read-platform', slug: 'read:platform', subject: ResourceType.Platform });

  const owner = makeOwner({
    roles: [makeRole('Owner', [readGame, createWebhookSubscription, managePlugin, manageOwnWebhooks, manageAll])],
    permissions: [makeGrant(readOwnNotification)],
  });

  const catalog = catalogOf([
    readGame,
    readOwnNotification,
    createWebhookSubscription,
    managePlugin,
    manageOwnWebhooks,
    manageAll,
    notHeld,
  ]);

  it('resolves a held slug to its permission id, type and risk', () => {
    expect(resolveRequestedScopes(owner, catalog, [{ slug: 'read:notification:own' }])).toEqual([
      {
        permissionId: readOwnNotification.id,
        slug: 'read:notification:own',
        resourceType: ResourceType.Notification,
        resourceId: null,
        riskLevel: RiskLevel.Medium,
      },
    ]);
  });

  it('refuses a slug the catalog lacks with API_KEY_SCOPE_NOT_GRANTABLE naming the slug', () => {
    const error = thrownBy(() => resolveRequestedScopes(owner, catalog, [{ slug: 'read:nothing' }]));

    expect(error.getStatus()).toBe(Http.UnprocessableEntity);
    expect(error.getResponse()).toMatchObject({ code: 'API_KEY_SCOPE_NOT_GRANTABLE', slug: 'read:nothing' });
  });

  // A permission on all reaches every type, and no pin can narrow it.
  it('refuses a held permission on all (manage:all) as not grantable', () => {
    const error = thrownBy(() => resolveRequestedScopes(owner, catalog, [{ slug: 'manage:all' }]));

    expect(error.getResponse()).toMatchObject({ code: 'API_KEY_SCOPE_NOT_GRANTABLE', slug: 'manage:all' });
  });

  it('refuses a slug the owner does not hold as not grantable', () => {
    const error = thrownBy(() => resolveRequestedScopes(owner, catalog, [{ slug: 'read:platform' }]));

    expect(error.getResponse()).toMatchObject({ code: 'API_KEY_SCOPE_NOT_GRANTABLE', slug: 'read:platform' });
  });

  it('refuses a pin on a create permission with API_KEY_SCOPE_NOT_PINNABLE', () => {
    const error = thrownBy(() =>
      resolveRequestedScopes(owner, catalog, [{ slug: 'create:webhook_subscription', resourceId: 'wh-1' }]),
    );

    expect(error.getStatus()).toBe(Http.UnprocessableEntity);
    expect(error.getResponse()).toMatchObject({
      code: 'API_KEY_SCOPE_NOT_PINNABLE',
      slug: 'create:webhook_subscription',
    });
  });

  // manage covers create, and the plugin artifact upload checks the type alone.
  it('refuses a pin on manage:plugin and accepts one on manage:webhook_subscription:own', () => {
    const error = thrownBy(() =>
      resolveRequestedScopes(owner, catalog, [{ slug: 'manage:plugin', resourceId: 'plugin-1' }]),
    );

    expect(error.getResponse()).toMatchObject({ code: 'API_KEY_SCOPE_NOT_PINNABLE', slug: 'manage:plugin' });
    expect(
      resolveRequestedScopes(owner, catalog, [{ slug: 'manage:webhook_subscription:own', resourceId: 'wh-1' }]),
    ).toEqual([
      {
        permissionId: manageOwnWebhooks.id,
        slug: 'manage:webhook_subscription:own',
        resourceType: ResourceType.WebhookSubscription,
        resourceId: 'wh-1',
        riskLevel: RiskLevel.Medium,
      },
    ]);
  });

  // The pinned row isn't looked up. A key is judged by its owner's ability and
  // its own together, so a pin on a row the owner can't reach, or on none,
  // reaches nothing.
  it('accepts a pin on a type it allows, even one naming no row: such a key reaches nothing', () => {
    expect(
      resolveRequestedScopes(owner, catalog, [{ slug: 'read:notification:own', resourceId: 'no-such-notification' }]),
    ).toEqual([expect.objectContaining({ permissionId: readOwnNotification.id, resourceId: 'no-such-notification' })]);
  });

  // The owner's grant is checked before the pin, so a client learns the key can't hold it at all.
  it('answers a pin on a slug the owner does not hold with API_KEY_SCOPE_NOT_GRANTABLE, not NOT_PINNABLE (#1418)', () => {
    const error = thrownBy(() => resolveRequestedScopes(owner, catalog, [{ slug: 'read:platform', resourceId: 'x' }]));

    expect(error.getResponse()).toMatchObject({ code: 'API_KEY_SCOPE_NOT_GRANTABLE', slug: 'read:platform' });
  });

  // The request DTO refuses an empty pin, so a route never sends one; this
  // shows only that duplicates are told apart by the pin as given.
  it('keeps an unpinned scope apart from the same slug pinned to an empty resourceId (#1418)', () => {
    const scopes = resolveRequestedScopes(owner, catalog, [
      { slug: 'read:notification:own' },
      { slug: 'read:notification:own', resourceId: '' },
    ]);

    expect(scopes.map(({ resourceId }) => resourceId)).toEqual([null, '']);
  });

  it('collapses the same unpinned slug requested twice into one scope', () => {
    const scopes = resolveRequestedScopes(owner, catalog, [{ slug: 'read:game' }, { slug: 'read:game' }]);

    expect(scopes).toEqual([expect.objectContaining({ permissionId: readGame.id, resourceId: null })]);
  });

  it('keeps an unpinned and a pinned scope over the same slug', () => {
    const scopes = resolveRequestedScopes(owner, catalog, [
      { slug: 'read:notification:own' },
      { slug: 'read:notification:own', resourceId: 'notification-1' },
      { slug: 'read:notification:own' },
      { slug: 'read:notification:own', resourceId: 'notification-1' },
    ]);

    expect(scopes.map(({ resourceId }) => resourceId)).toEqual([null, 'notification-1']);
  });

  it('expands everything to one unpinned scope per grantable permission, leaving out permissions on all', () => {
    const scopes = everythingScopes(owner, catalog);

    expect(scopes.map(({ slug }) => slug)).toEqual(grantablePermissions(owner).map(({ slug }) => slug));
    expect(scopes.map(({ slug }) => slug)).not.toContain('manage:all');
    expect(scopes.map(({ resourceId }) => resourceId)).toEqual(scopes.map(() => null));
    expect(scopes).toContainEqual({
      permissionId: managePlugin.id,
      slug: 'manage:plugin',
      resourceType: ResourceType.Plugin,
      resourceId: null,
      riskLevel: RiskLevel.Critical,
    });
  });

  // The catalog holds only permissions that aren't retired; a cached graph
  // can still carry one retired since.
  it('leaves out of everything a permission the catalog no longer holds', () => {
    const withoutReadGame = catalogOf([
      readOwnNotification,
      createWebhookSubscription,
      managePlugin,
      manageOwnWebhooks,
    ]);

    expect(everythingScopes(owner, withoutReadGame).map(({ slug }) => slug)).not.toContain('read:game');
  });
});

describe('addsCritical (#1418)', () => {
  const critical: ResolvedScope = {
    permissionId: 'perm-manage-plugin',
    slug: 'manage:plugin',
    resourceType: ResourceType.Plugin,
    resourceId: null,
    riskLevel: RiskLevel.Critical,
  };
  const low: ResolvedScope = {
    permissionId: 'perm-read-game',
    slug: 'read:game',
    resourceType: ResourceType.Game,
    resourceId: null,
    riskLevel: RiskLevel.Low,
  };

  it('is true for a Critical permission the key does not hold yet', () => {
    expect(addsCritical([low, critical], new Set())).toBe(true);
  });

  // An edit that keeps a Critical permission the key already holds adds none.
  it('is false when the Critical permission is already held', () => {
    expect(addsCritical([low, critical], new Set([critical.permissionId]))).toBe(false);
  });

  it('is false with no Critical permission', () => {
    expect(addsCritical([low], new Set())).toBe(false);
  });
});

describe('assertCriticalAllowed (#1418)', () => {
  const now = Date.parse('2026-11-23T12:00:00.000Z');
  const freshAgeSeconds = 24 * 60 * 60;
  const exactlyStale = new Date(now - freshAgeSeconds * 1000);

  it('passes with no Critical permission, whatever the other inputs', () => {
    expect(() =>
      assertCriticalAllowed({ addsCritical: false, confirmed: false, signedInAt: null, now, freshAgeSeconds }),
    ).not.toThrow();
  });

  // Confirmation is asked for first, so a client asks the owner before sending them to sign in.
  it('refuses an unconfirmed Critical permission with API_KEY_CRITICAL_NEEDS_CONFIRMATION, even with a stale session', () => {
    const error = thrownBy(() =>
      assertCriticalAllowed({ addsCritical: true, confirmed: false, signedInAt: null, now, freshAgeSeconds }),
    );

    expect(error.getStatus()).toBe(Http.UnprocessableEntity);
    expect(error.getResponse()).toMatchObject({ code: 'API_KEY_CRITICAL_NEEDS_CONFIRMATION' });
  });

  // better-auth's rule: a session exactly freshAge old is already stale.
  it('refuses a session signed in exactly freshAgeSeconds ago with API_KEY_NEEDS_RECENT_SIGN_IN', () => {
    const error = thrownBy(() =>
      assertCriticalAllowed({ addsCritical: true, confirmed: true, signedInAt: exactlyStale, now, freshAgeSeconds }),
    );

    expect(error.getStatus()).toBe(Http.Forbidden);
    expect(error.getResponse()).toMatchObject({ code: 'API_KEY_NEEDS_RECENT_SIGN_IN' });
  });

  it('passes a confirmed Critical permission from a session one ms younger', () => {
    const signedInAt = new Date(exactlyStale.getTime() + 1);

    expect(() =>
      assertCriticalAllowed({ addsCritical: true, confirmed: true, signedInAt, now, freshAgeSeconds }),
    ).not.toThrow();
  });

  // No known sign-in time can't show a recent sign-in.
  it('refuses when the sign-in time is unknown', () => {
    const error = thrownBy(() =>
      assertCriticalAllowed({ addsCritical: true, confirmed: true, signedInAt: null, now, freshAgeSeconds }),
    );

    expect(error.getResponse()).toMatchObject({ code: 'API_KEY_NEEDS_RECENT_SIGN_IN' });
  });

  // better-auth's rule: a freshAge of 0 checks nothing.
  it('passes any session when freshAgeSeconds is 0', () => {
    expect(() =>
      assertCriticalAllowed({ addsCritical: true, confirmed: true, signedInAt: null, now, freshAgeSeconds: 0 }),
    ).not.toThrow();
    expect(() =>
      assertCriticalAllowed({ addsCritical: true, confirmed: true, signedInAt: exactlyStale, now, freshAgeSeconds: 0 }),
    ).not.toThrow();
  });
});

describe('expiryDate (#1418)', () => {
  const now = Date.parse('2026-11-23T12:00:00.000Z');

  it('accepts 1 and 365 days', () => {
    expect(expiryDate(1, now)).toEqual(new Date(now + DAY_MS));
    expect(expiryDate(365, now)).toEqual(new Date(now + 365 * DAY_MS));
  });

  it('gives now plus 90 days for 90', () => {
    expect(expiryDate(90, now)).toEqual(new Date(now + 90 * DAY_MS));
  });

  it.each([0, 366, -1])('refuses %p days with API_KEY_EXPIRY_OUT_OF_RANGE naming the range', (days) => {
    const error = thrownBy(() => expiryDate(days, now));

    expect(error.getStatus()).toBe(Http.UnprocessableEntity);
    expect(error.getResponse()).toMatchObject({ code: 'API_KEY_EXPIRY_OUT_OF_RANGE', min: 1, max: 365 });
  });
});

describe('assertExpiryInRange (#1418)', () => {
  it.each([1, 365])('accepts %p days', (days) => {
    expect(() => assertExpiryInRange(days)).not.toThrow();
  });

  it.each([0, 366])('refuses %p days with API_KEY_EXPIRY_OUT_OF_RANGE naming the range', (days) => {
    const error = thrownBy(() => assertExpiryInRange(days));

    expect(error.getStatus()).toBe(Http.UnprocessableEntity);
    expect(error.getResponse()).toMatchObject({ code: 'API_KEY_EXPIRY_OUT_OF_RANGE', min: 1, max: 365 });
  });
});

/** The catalog a route passes in: the permissions that aren't retired, keyed by slug. */
function catalogOf(permissions: Permission[]): ReadonlyMap<string, Permission> {
  return new Map(permissions.map((permission) => [permission.slug, permission]));
}

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
    resourceType: subjectOf(permission),
    resourceId: null,
    expiresAt: null,
    permission: { id, action, subject, conditions, fields, inverted, slug, riskLevel, retiredAt },
  };
}

/** A direct grant's resourceType is the subject it holds the permission on (holdingContexts reads it so). */
function subjectOf(permission: Permission): ResourceType {
  const subject = Object.values(ResourceType).find((type) => type === permission.subject);

  if (!subject) {
    throw new Error(`Expected a permission on a resource type, got ${permission.subject}`);
  }

  return subject;
}

/** The coded refusal `act` throws; anything else fails the test. */
function thrownBy(act: () => unknown): CodedHttpException {
  try {
    act();
  } catch (error) {
    if (error instanceof CodedHttpException) {
      return error;
    }

    throw error;
  }

  throw new Error('Expected a CodedHttpException, but nothing was thrown');
}
