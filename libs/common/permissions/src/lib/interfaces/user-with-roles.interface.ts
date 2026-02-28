import type { Permission } from '@bge/database';

export interface UserWithRoles {
  id: string;
  householdMember: HouseholdMemberWithRole[];
  eventsAttended: EventAttendWithRole[];
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
