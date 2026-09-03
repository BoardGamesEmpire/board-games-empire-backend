import { SystemRole } from '../client';
import { assertEveryRoleSeeded } from './catalog-integrity';
import type { RoleScope, RoleSeedDefinition } from './seed-definitions';

/**
 * The seeded system roles. Every entry is written with `isSystem: true`.
 */
export const ROLE_CATALOG = [
  // System
  { name: SystemRole.Owner, description: 'System owner with absolute control' },
  { name: SystemRole.Admin, description: 'Full access to all system functions' },
  { name: SystemRole.Moderator, description: 'Can moderate content but cannot change system settings' },
  { name: SystemRole.User, description: 'Standard user account' },

  // Household
  { name: SystemRole.HouseholdOwner, description: 'Owner of a household with full control' },
  { name: SystemRole.HouseholdAdmin, description: 'Can manage household settings and members' },
  { name: SystemRole.HouseholdMember, description: 'Regular household member' },
  { name: SystemRole.HouseholdGuest, description: 'Limited access household guest' },

  // Event
  { name: SystemRole.EventHost, description: 'Host of an event with permissions to manage it' },
  { name: SystemRole.EventCoHost, description: 'Co-Host of an event' },
  { name: SystemRole.EventOrganizer, description: 'Logistics focused, no moderation' },
  { name: SystemRole.EventModerator, description: 'Moderator scoped to an event' },
  { name: SystemRole.EventParticipant, description: 'Active participant in an event' },

  // is there are difference?
  { name: SystemRole.EventGuest, description: 'Limited access event guest' },
  { name: SystemRole.EventSpectator, description: 'Read-only observer for an event' },
] as const satisfies readonly RoleSeedDefinition[];

assertEveryRoleSeeded(ROLE_CATALOG);

/**
 * Which `AbilityFactory.createForUser` pass each role arrives through, and
 * therefore which scope coordinate its permissions' conditions can bind to.
 * See `RoleScope`. An explicit map, one entry per `SystemRole`, so the
 * compiler — not a naming convention — guarantees every role is classified.
 */
export const ROLE_SCOPE: Readonly<Record<SystemRole, RoleScope>> = {
  [SystemRole.Owner]: 'global',
  [SystemRole.Admin]: 'global',
  [SystemRole.Moderator]: 'global',
  [SystemRole.User]: 'global',

  [SystemRole.HouseholdOwner]: 'household',
  [SystemRole.HouseholdAdmin]: 'household',
  [SystemRole.HouseholdMember]: 'household',
  [SystemRole.HouseholdGuest]: 'household',

  [SystemRole.EventHost]: 'event',
  [SystemRole.EventCoHost]: 'event',
  [SystemRole.EventOrganizer]: 'event',
  [SystemRole.EventModerator]: 'event',
  [SystemRole.EventParticipant]: 'event',
  [SystemRole.EventGuest]: 'event',
  [SystemRole.EventSpectator]: 'event',
};
