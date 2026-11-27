import type { Permission } from '@bge/database';
import { isAttendanceOnly } from '@bge/database';
import type { RoleWithPermissions, UserPermissionWithPermission, UserWithRoles } from '../interfaces';

/** What gives the owner a permission in a holding context (#266). */
export type HoldingSource = 'directPermission' | 'event' | 'household' | 'serverRole';

/**
 * One place where an API key's owner holds a permission, as the owner's own
 * ability renders it there. A key scope over that permission gets one rule per
 * holding context (#266).
 */
export interface HoldingContext {
  /** The Mustache context the owner's own rule renders with: { user, role } | { user, role, householdId } | { user, role, eventId } | { user }. */
  readonly context: Record<string, unknown>;

  /**
   * The permission row as the owner's graph holds it, with the slug, risk
   * level and retirement an API key's create screen reads (#1417).
   */
  readonly permission: UserPermissionWithPermission['permission'];

  /** A direct permission's own pin, carried over as the owner's rule carries it; null otherwise. */
  readonly resourceId: string | null;

  /** What gives the owner the permission here, so a log line can name it without reading the context's keys. */
  readonly source: HoldingSource;

  /** The CASL subject of the owner's rule: the permission's subject, or a direct permission's resourceType. */
  readonly subject: string;
}

/**
 * Every server role, household membership, event attendance and direct
 * permission that gives `owner` the permission `permissionId` with its own
 * polarity, in the order `AbilityFactory.createForUser` applies them.
 *
 * A direct permission counts only where the owner's own ability builds a rule
 * of that polarity from it: it is skipped where
 * {@link buildsDirectPermissionRule} says no rule is built, and where its own
 * `inverted` flag flips the permission's polarity. A membership or attendance
 * the owner no longer has is not in the graph, so a key stops reaching that
 * household or event on the next graph load (#266).
 */
export function holdingContexts(owner: UserWithRoles, permissionId: string, now = Date.now()): HoldingContext[] {
  const held: HoldingContext[] = [];

  for (const { role } of owner.roles) {
    const permission = grantedBy(role, permissionId);

    if (permission) {
      held.push({
        context: { user: owner, role: role.name },
        source: 'serverRole',
        subject: permission.subject,
        resourceId: null,
        permission,
      });
    }
  }

  for (const member of owner.householdMember) {
    const permission = grantedBy(member.role?.role, permissionId);

    if (permission) {
      const context = { user: owner, role: member.role?.role.name, householdId: member.householdId };
      held.push({ context, source: 'household', subject: permission.subject, resourceId: null, permission });
    }
  }

  for (const attendee of owner.eventsAttended) {
    const permission = grantedBy(attendee.role?.role, permissionId);

    if (permission) {
      const context = { user: owner, role: attendee.role?.role.name, eventId: attendee.eventId };
      held.push({ context, source: 'event', subject: permission.subject, resourceId: null, permission });
    }
  }

  for (const direct of owner.permissions) {
    const { permission } = direct;

    if (permission.id !== permissionId || !buildsDirectPermissionRule(direct, now)) {
      continue;
    }

    if (isDirectPermissionDenial(direct) !== permission.inverted) {
      continue;
    }

    held.push({
      context: { user: owner },
      source: 'directPermission',
      subject: direct.resourceType,
      resourceId: direct.resourceId,
      permission,
    });
  }

  return held;
}

/**
 * Every context the owner has, held or not: `{ user }`, then one per server
 * role (`{ user, role }`), one per household membership
 * (`{ user, householdId, role }`) and one per event attendance
 * (`{ user, eventId, role }`), the contexts `AbilityFactory.createForUser`
 * renders the owner's own rules in. A denial only narrows, so a key scope over
 * a denial renders in each of them whether or not the owner holds it there
 * (#266).
 */
export function ownerContexts(owner: UserWithRoles): Record<string, unknown>[] {
  return [
    { user: owner },
    ...owner.roles.map(({ role }) => ({ user: owner, role: role.name })),
    ...owner.householdMember.map((member) => ({
      user: owner,
      householdId: member.householdId,
      role: member.role?.role.name,
    })),
    ...owner.eventsAttended.map((attendee) => ({
      user: owner,
      eventId: attendee.eventId,
      role: attendee.role?.role.name,
    })),
  ];
}

/**
 * Whether the owner's own ability builds a rule from a direct permission at
 * all. Three things stop it:
 *
 * - the row is no longer in force;
 * - its permission is on the `'all'` wildcard, which is never directly
 *   assignable (wildcard authority is role-gated only);
 * - the row is an allow on an attendance-only resource type, which only an
 *   event role grants (#1543). A denial on one still builds its `cannot`, so
 *   the row's own polarity is read here ({@link isDirectPermissionDenial}),
 *   and the type is the row's `resourceType`, the subject of the rule it
 *   would build.
 *
 * The owner's ability and an API key's both ask this one predicate, so a key
 * never borrows a direct permission its owner's ability leaves out (#266).
 */
export function buildsDirectPermissionRule(
  direct: Pick<UserPermissionWithPermission, 'expiresAt' | 'inverted' | 'permission' | 'resourceType'>,
  now: number,
): boolean {
  if (direct.permission.subject === 'all' || !isActiveDirectPermission(direct, now)) {
    return false;
  }

  return isDirectPermissionDenial(direct) || !isAttendanceOnly(direct.resourceType);
}

/**
 * Whether a direct permission is still in force. The loader already leaves out
 * expired rows, but a cached graph can outlive a row's `expiresAt`, and its
 * `Date` arrives as an ISO string once the graph round-trips through the
 * cache, so the value is normalized before comparing.
 */
function isActiveDirectPermission(direct: Pick<UserPermissionWithPermission, 'expiresAt'>, now: number): boolean {
  return direct.expiresAt === null || new Date(direct.expiresAt).getTime() > now;
}

/**
 * Whether a direct permission builds a `cannot`: its own `inverted` flag sets
 * the polarity when it is `true` or `false`, and `null` inherits the
 * permission's.
 */
export function isDirectPermissionDenial(
  direct: Pick<UserPermissionWithPermission, 'inverted' | 'permission'>,
): boolean {
  return direct.inverted ?? direct.permission.inverted;
}

function grantedBy(role: RoleWithPermissions['role'] | undefined, permissionId: string): Permission | undefined {
  return role?.permissions.find(({ permission }) => permission.id === permissionId)?.permission;
}
