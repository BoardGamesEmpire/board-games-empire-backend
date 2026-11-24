import type { Permission } from '@bge/database';
import { Action, ResourceType } from '@bge/database';
import { makePermission } from '@bge/testing';
import type { RoleWithPermissions, UserPermissionWithPermission, UserWithRoles } from '../interfaces';
import { holdingContexts, ownerContexts } from './holding-contexts';

const NOW = Date.parse('2026-11-23T12:00:00.000Z');

// A key scope renders in each context where its owner holds the scope's
// permission, the way the owner's own rule renders there (#266).
describe('holdingContexts (#266)', () => {
  const held = makePermission({ id: 'perm-held', action: Action.read, subject: 'Household' });
  // Same action and subject, a different row: holding it is not holding `held`.
  const lookalike = makePermission({ id: 'perm-lookalike', action: Action.read, subject: 'Household' });

  it('yields one context per server role that grants it, with { user, role }', () => {
    const owner = makeOwner({
      roles: [makeRole('User', [held]), makeRole('Moderator', [lookalike]), makeRole('Admin', [lookalike, held])],
    });

    expect(holdingContexts(owner, held.id, NOW)).toEqual([
      {
        context: { user: owner, role: 'User' },
        source: 'serverRole',
        subject: 'Household',
        resourceId: null,
        permission: held,
      },
      {
        context: { user: owner, role: 'Admin' },
        source: 'serverRole',
        subject: 'Household',
        resourceId: null,
        permission: held,
      },
    ]);
  });

  it('renders a household permission once per membership that grants it', () => {
    const owner = makeOwner({
      householdMember: [
        { householdId: 'hh-A', role: makeRole('HouseholdMember', [held]) },
        { householdId: 'hh-B', role: makeRole('HouseholdAdmin', [held]) },
        { householdId: 'hh-C', role: makeRole('HouseholdGuest', [lookalike]) },
        { householdId: 'hh-D', role: null },
      ],
    });

    expect(holdingContexts(owner, held.id, NOW).map(({ context, source }) => ({ context, source }))).toEqual([
      { context: { user: owner, role: 'HouseholdMember', householdId: 'hh-A' }, source: 'household' },
      { context: { user: owner, role: 'HouseholdAdmin', householdId: 'hh-B' }, source: 'household' },
    ]);
  });

  it("yields an event attendance's context with eventId", () => {
    const owner = makeOwner({
      eventsAttended: [
        { eventId: 'ev-1', role: makeRole('EventGuest', [held]) },
        { eventId: 'ev-2', role: makeRole('EventGuest', [lookalike]) },
      ],
    });

    expect(holdingContexts(owner, held.id, NOW)).toEqual([
      {
        context: { user: owner, role: 'EventGuest', eventId: 'ev-1' },
        source: 'event',
        subject: 'Household',
        resourceId: null,
        permission: held,
      },
    ]);
  });

  it('yields a direct permission with { user }, its resourceType as subject and its resourceId', () => {
    const grant = makeGrant(held, { resourceType: ResourceType.HouseholdMember, resourceId: 'member-9' });
    const owner = makeOwner({ permissions: [grant, makeGrant(lookalike)] });

    expect(holdingContexts(owner, held.id, NOW)).toEqual([
      {
        context: { user: owner },
        source: 'directPermission',
        subject: ResourceType.HouseholdMember,
        resourceId: 'member-9',
        permission: grant.permission,
      },
    ]);
  });

  // A cached graph round-trips through JSON, so `expiresAt` arrives as a string.
  it('skips an expired direct permission', () => {
    const owner = makeOwner({
      permissions: [
        makeGrant(held, { resourceId: 'hh-expired', expiresAt: jsonDate('2026-11-23T11:59:59.000Z') }),
        makeGrant(held, { resourceId: 'hh-live', expiresAt: jsonDate('2026-11-23T12:00:01.000Z') }),
      ],
    });

    expect(holdingContexts(owner, held.id, NOW).map(({ resourceId }) => resourceId)).toEqual(['hh-live']);
  });

  // The owner's own ability turns that row into a `cannot`, so it gives the
  // owner nothing a key's allow could borrow.
  it('skips a direct permission whose own inverted flag makes it a denial', () => {
    const owner = makeOwner({ permissions: [makeGrant(held, { inverted: true })] });

    expect(holdingContexts(owner, held.id, NOW)).toEqual([]);
  });

  // Wildcard authority is role-gated only, so the owner's ability skips this
  // row and a key can't hold it through one.
  it("skips a direct permission on the 'all' subject", () => {
    const wildcard = makePermission({ id: 'perm-wildcard', action: Action.manage, subject: 'all' });
    const owner = makeOwner({ permissions: [makeGrant(wildcard, { resourceType: ResourceType.Household })] });

    expect(holdingContexts(owner, wildcard.id, NOW)).toEqual([]);
  });

  // Which permissions a key holds is fixed when it is made; which households
  // they reach follows its owner's memberships as the graph loads now.
  it('builds no rule for a membership the owner no longer has', () => {
    const memberships = [
      { householdId: 'hh-A', role: makeRole('HouseholdMember', [held]) },
      { householdId: 'hh-B', role: makeRole('HouseholdMember', [held]) },
    ];
    const afterLeavingB = makeOwner({ householdMember: memberships.slice(0, 1) });

    expect(holdingContexts(afterLeavingB, held.id, NOW).map(({ context }) => context['householdId'])).toEqual(['hh-A']);
  });

  it("yields nothing for a permission the owner doesn't hold", () => {
    const owner = makeOwner({
      roles: [makeRole('User', [lookalike])],
      householdMember: [{ householdId: 'hh-A', role: makeRole('HouseholdMember', [lookalike]) }],
      permissions: [makeGrant(lookalike)],
    });

    expect(holdingContexts(owner, held.id, NOW)).toEqual([]);
  });
});

// A denial only narrows, so it renders in every context the owner has, held
// or not (#266).
describe('ownerContexts (#266)', () => {
  it('yields one user context, then each membership, then each attendance', () => {
    const owner = makeOwner({
      roles: [makeRole('User', [])],
      householdMember: [
        { householdId: 'hh-A', role: makeRole('HouseholdMember', []) },
        { householdId: 'hh-B', role: null },
      ],
      eventsAttended: [{ eventId: 'ev-1', role: makeRole('EventGuest', []) }],
    });

    expect(ownerContexts(owner)).toEqual([
      { user: owner },
      { user: owner, householdId: 'hh-A', role: 'HouseholdMember' },
      { user: owner, householdId: 'hh-B', role: undefined },
      { user: owner, eventId: 'ev-1', role: 'EventGuest' },
    ]);
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

function makeGrant(
  permission: Permission,
  overrides: Partial<Omit<UserPermissionWithPermission, 'permission'>> = {},
): UserPermissionWithPermission {
  const { id, action, subject, conditions, fields, inverted } = permission;

  return {
    inverted: null,
    resourceType: ResourceType.Household,
    resourceId: null,
    expiresAt: null,
    permission: { id, action, subject, conditions, fields, inverted },
    ...overrides,
  };
}

/** A date as a cached graph carries it: an ISO string where the type says `Date`. */
function jsonDate(iso: string): Date {
  return iso as unknown as Date;
}
