import type { Permission, UserPermission } from '@bge/database';

export interface UserWithRoles {
  id: string;
  householdMember: HouseholdMemberWithRole[];
  eventsAttended: EventAttendWithRole[];
  roles: RoleWithPermissions[];
  permissions: UserPermissionWithPermission[];
}

export interface EventAttendWithRole {
  eventId: string;
  role: RoleWithPermissions | null;
}

export interface HouseholdMemberWithRole {
  householdId: string;
  role: RoleWithPermissions | null;
}

export interface RoleWithPermissions {
  role: RoleName & Permissions;
}

type RoleName = { name: string };

export interface Permissions {
  permissions: {
    permission: Permission;
  }[];
}

/**
 * A direct {@link UserPermission} row joined to the slice of its {@link Permission}
 * the AbilityFactory needs to materialize a CASL rule:
 * - `action` / `subject` — the rule's verb and target. `subject` is checked against
 *   the `'all'` wildcard, which is never directly assignable (wildcard authority is
 *   role-gated only and is blocked in the factory).
 * - `conditions` — ABAC template, rendered with a user-only context then merged with
 *   the instance pin (`{ ...rendered, id: resourceId }`) when a `resourceId` is set.
 * - `fields` — field-level restriction, honored exactly as on role-derived rules.
 * - `inverted` (base) — the permission's default polarity, inherited when the
 *   `UserPermission.inverted` override is `null`.
 *
 * `resourceType`, `resourceId`, and `expiresAt` come from the `UserPermission` row.
 * `UserPermission.inverted` is a tri-state override: `true`/`false` force the rule's
 * polarity, while `null` inherits `Permission.inverted` (the base default).
 */
export interface UserPermissionWithPermission extends Pick<
  UserPermission,
  'inverted' | 'resourceType' | 'resourceId' | 'expiresAt'
> {
  permission: Pick<Permission, 'action' | 'subject' | 'conditions' | 'fields' | 'inverted'>;
}
