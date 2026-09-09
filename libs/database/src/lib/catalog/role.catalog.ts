import { SystemRole } from '../client';
import { assertEveryRoleSeeded } from './catalog-integrity';
import type { RoleScope, RoleSeedDefinition } from './seed-definitions';

/**
 * The seeded system roles. The reconciler writes every entry as
 * `managedBy: System` (#235) and never mutates a role it does not own.
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

  // Is there a difference between these two? Open question, carried over from the seed.
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

/**
 * `user` in every role pass is the permission graph as
 * `PermissionsService.loadUserGraph` selects it — `id` plus the role-carrying
 * relations — not the `User` row. A column's existence on the model says
 * nothing about whether it is loaded: `{{ user.email }}` renders `''` today
 * because the graph never selects `email`, which is exactly the inert grant
 * the render join exists to catch. So this list is what the graph loads, and
 * the factory's spec pins it to `UserWithRoles`, the graph's own type, so the
 * two cannot drift apart silently.
 */
const USER_VARIABLES: readonly string[] = ['user.id'];

/**
 * The variables each ROLE pass of `AbilityFactory.createForUser` places in
 * its Mustache context. The `roles` pass renders `{ user, role }`, where
 * `role` is the role's NAME as a string; the `householdMember` pass adds
 * `householdId`; the `eventsAttended` pass adds `eventId`. A variable the
 * pass does not supply renders to `''` — a clause that matches nothing — so
 * `catalog-guards.ts` joins this map with `ROLE_SCOPE` to find grants that
 * can never fire (#234, #244, #436).
 *
 * Direct user permissions (`applyUserPermissions`) are not a role pass: they
 * render against `{ user }` alone and are not role↔permission edges, so they
 * have no key here. The factory documents which templates are safe to assign
 * directly as an operator concern.
 *
 * This is the lower layer, so the map lives here and the factory's spec is
 * checked against it rather than the other way round: `@bge/permissions`
 * imports this library, and a catalog spec could not import the factory
 * back without inverting that dependency.
 */
export const RENDER_CONTEXT_VARIABLES: Readonly<Record<RoleScope, readonly string[]>> = {
  global: [...USER_VARIABLES, 'role'],
  household: [...USER_VARIABLES, 'role', 'householdId'],
  event: [...USER_VARIABLES, 'role', 'eventId'],
};

/**
 * The variables `AbilityFactory.createForPlugin` places in its context —
 * `{ plugin: { id, slug }, unit: clonePluginUnit(unit) }`, where the unit
 * always carries `scopeType` and, by variant, `householdId` or `userId`
 * (#60, #315). No role pass supplies any of these, so a plugin-conditioned
 * permission granted to a role is caught by the render join, while the
 * variable itself is not mistaken for a typo.
 */
export const PLUGIN_CONTEXT_VARIABLES: readonly string[] = [
  'plugin.id',
  'plugin.slug',
  'unit.scopeType',
  'unit.householdId',
  'unit.userId',
];

/** Every variable a catalog condition may reference: the union of every render context above. */
export const KNOWN_TEMPLATE_VARIABLES: readonly string[] = [
  ...new Set([...Object.values(RENDER_CONTEXT_VARIABLES).flat(), ...PLUGIN_CONTEXT_VARIABLES]),
];
