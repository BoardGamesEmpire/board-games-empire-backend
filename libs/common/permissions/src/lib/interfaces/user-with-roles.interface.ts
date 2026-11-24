import type { Permission, UserPermission } from '@bge/database';

export interface UserWithRoles {
  eventsAttended: EventAttendWithRole[];
  householdMember: HouseholdMemberWithRole[];
  id: string;
  permissions: UserPermissionWithPermission[];
  roles: RoleWithPermissions[];
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
 * - `id` — the permission row, which an API key's key scope names: a key scope
 *   renders in each context where its owner holds that row, a direct
 *   permission among them (#266).
 * - `action` / `subject` — the rule's verb and target. `subject` is checked against
 *   the `'all'` wildcard, which is never directly assignable (wildcard authority is
 *   role-gated only and is blocked in the factory).
 * - `conditions` — the permission's condition, rendered with a user-only
 *   context. On the user's own rule the instance pin is merged in (`{ ...rendered, id: resourceId }`) when
 *   a `resourceId` is set; on an API key's rule the pin is ANDed with the rendered
 *   conditions instead, so a condition that names `id` is narrowed, never replaced.
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
  permission: Pick<Permission, 'id' | 'action' | 'subject' | 'conditions' | 'fields' | 'inverted'>;
}
