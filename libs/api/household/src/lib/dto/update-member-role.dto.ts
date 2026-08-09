import { SystemRole } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

/**
 * The roles assignable through the change-role endpoint. `HouseholdOwner` is
 * deliberately absent: every owner transition (promotion AND demotion) is the
 * exclusive domain of the transfer-ownership flow (#158), so it can stay an
 * atomic swap with both caches invalidated together.
 */
export const ASSIGNABLE_HOUSEHOLD_ROLES = [
  SystemRole.HouseholdAdmin,
  SystemRole.HouseholdMember,
  SystemRole.HouseholdGuest,
] as const;

export type AssignableHouseholdRole = (typeof ASSIGNABLE_HOUSEHOLD_ROLES)[number];

/**
 * Narrows an arbitrary `SystemRole` to the household-assignable subset.
 *
 * Exists because the roles that reach a write path do not always arrive
 * pre-narrowed: an invite carries a `Role` FK, so #163 reads back a plain
 * `SystemRole` and has to decide whether it may be assigned. Without this,
 * every such caller writes its own `includes` check or — worse — casts.
 */
export function isAssignableHouseholdRole(role: SystemRole): role is AssignableHouseholdRole {
  return (ASSIGNABLE_HOUSEHOLD_ROLES as readonly SystemRole[]).includes(role);
}

export class UpdateMemberRoleDto {
  @ApiProperty({
    enum: ASSIGNABLE_HOUSEHOLD_ROLES,
    description: 'Target household role (owner transitions go through transfer-ownership)',
  })
  @IsIn(ASSIGNABLE_HOUSEHOLD_ROLES, { message: i18nValidationMessage('validation.isIn') })
  role!: AssignableHouseholdRole;
}
