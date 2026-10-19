import { Prisma, SystemRole } from '@bge/database';

/**
 * Each member's user id and household role: what the invite grants' role
 * clause reads off an instance. The invite routes ask about the household's
 * whole roster, as the condition is written over it: a roster cut down to the
 * caller's own row answers today's `some` clause the same, but would pass a
 * `none` or `every` clause it should refuse.
 */
export const ROSTER_ROLE_SELECT = {
  userId: true,
  role: { select: { role: { select: { name: true } } } },
} as const satisfies Prisma.HouseholdMemberSelect;

export type RosterRow = Prisma.HouseholdMemberGetPayload<{ select: typeof ROSTER_ROLE_SELECT }>;

/**
 * The household roles that answer for a household's invites: its owners and
 * admins. They always see who is invited to their household, the address
 * included (#167), and they are who the household's invite notifications go
 * to.
 */
export const HOUSEHOLD_AUTHORITY_ROLES: readonly SystemRole[] = [SystemRole.HouseholdOwner, SystemRole.HouseholdAdmin];

/**
 * Whether the roster names `userId` one of the household's owners or admins.
 *
 * Decided by their role in this household's own roster, never by a grant:
 * staff read every invite through a wildcard grant, and a custom role (#169)
 * may hand a member a permission, but neither makes them the household's
 * owner or admin. An actor with no user, such as a plugin actor, is never one.
 */
export function isHouseholdAuthority(members: readonly RosterRow[], userId: string | null): boolean {
  return (
    userId !== null &&
    members.some(
      (member) => member.userId === userId && HOUSEHOLD_AUTHORITY_ROLES.some((role) => role === member.role?.role.name),
    )
  );
}
