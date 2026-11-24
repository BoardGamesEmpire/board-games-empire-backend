import type { Permission } from '@bge/database';
import type { RoleWithPermissions, UserPermissionWithPermission, UserWithRoles } from '../interfaces';

/**
 * One place where an API key's owner holds a permission, as the owner's own
 * ability renders it there. A key scope over that permission gets one rule per
 * holding context (#266).
 */
export interface HoldingContext {
  /** The Mustache context the owner's own rule renders with: { user, role } | { user, role, householdId } | { user, role, eventId } | { user }. */
  readonly context: Record<string, unknown>;

  /** The permission row as the owner's graph holds it. */
  readonly permission: Pick<Permission, 'id' | 'action' | 'subject' | 'conditions' | 'fields' | 'inverted'>;

  /** A direct grant's own pin, carried over as the owner's rule carries it; null otherwise. */
  readonly resourceId: string | null;

  /** The CASL subject of the owner's rule: the permission's subject, or a direct grant's resourceType. */
  readonly subject: string;
}

/**
 * Every server role, household membership, event attendance and active direct
 * grant that gives `owner` the permission `permissionId` with its own
 * polarity, in the order `AbilityFactory.createForUser` applies them.
 *
 * A direct grant counts only where the owner's own ability builds a rule of
 * that polarity from it: it is skipped when expired, when its override flips
 * the permission's polarity, or when the permission is on the `'all'`
 * wildcard, which is never directly assignable. A membership or attendance
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
      held.push({ context, subject: permission.subject, resourceId: null, permission });
    }
  }

  for (const attendee of owner.eventsAttended) {
    const permission = grantedBy(attendee.role?.role, permissionId);

    if (permission) {
      const context = { user: owner, role: attendee.role?.role.name, eventId: attendee.eventId };
      held.push({ context, subject: permission.subject, resourceId: null, permission });
    }
  }

  for (const grant of owner.permissions) {
    const { permission } = grant;

    if (permission.id !== permissionId || permission.subject === 'all' || !isActiveDirectGrant(grant, now)) {
      continue;
    }

    if (isDirectGrantDenial(grant) !== permission.inverted) {
      continue;
    }

    held.push({ context: { user: owner }, subject: grant.resourceType, resourceId: grant.resourceId, permission });
  }

  return held;
}

/**
 * Every context the owner has, held or not: `{ user }`, then one per household
 * membership (`{ user, householdId, role }`) and one per event attendance
 * (`{ user, eventId, role }`). A denial only narrows, so an inverted key scope
 * renders in each of them whether or not the owner holds it there (#266).
 */
export function ownerContexts(owner: UserWithRoles): Record<string, unknown>[] {
  return [
    { user: owner },
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
 * Whether a direct grant is still in force. The loader already leaves out
 * expired rows, but a cached graph can outlive a row's `expiresAt`, and its
 * `Date` arrives as an ISO string once the graph round-trips through the
 * cache, so the value is normalized before comparing.
 */
export function isActiveDirectGrant(grant: Pick<UserPermissionWithPermission, 'expiresAt'>, now: number): boolean {
  return grant.expiresAt === null || new Date(grant.expiresAt).getTime() > now;
}

/**
 * Whether a direct grant builds a `cannot`: `UserPermission.inverted`
 * overrides the permission's polarity, and `null` inherits it.
 */
export function isDirectGrantDenial(grant: UserPermissionWithPermission): boolean {
  return grant.inverted ?? grant.permission.inverted;
}

function grantedBy(role: RoleWithPermissions['role'] | undefined, permissionId: string): Permission | undefined {
  return role?.permissions.find(({ permission }) => permission.id === permissionId)?.permission;
}
