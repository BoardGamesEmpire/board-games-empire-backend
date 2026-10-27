import { Action, DatabaseService, Prisma, ResourceType, SystemRole } from '@bge/database';
import type { AbilityService } from '@bge/permissions';
import { isAssignableHouseholdRole, type AssignableHouseholdRole } from '../dto';

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
 * The household's whole roster, each member's user id and household role, as
 * `client` reads it: the instance the invite routes and the ban routes (#782)
 * ask their grants about.
 */
export function readRoster(
  client: DatabaseService | Prisma.TransactionClient,
  householdId: string,
): Promise<RosterRow[]> {
  return client.householdMember.findMany({ where: { householdId }, select: ROSTER_ROLE_SELECT });
}

/**
 * The household setting a member's invite is asked about (#166): whether
 * members may invite, and whether their invite waits for approval.
 */
const INVITE_SETTINGS_SELECT = { memberInvitePolicy: true } as const satisfies Prisma.HouseholdSettingsSelect;

/**
 * What the invite grants read off a household, beside the invite: its roster
 * with each member's household role, and its member invite policy (#166).
 */
export interface InviteAuthority {
  readonly members: RosterRow[];
  readonly settings: Prisma.HouseholdSettingsGetPayload<{ select: typeof INVITE_SETTINGS_SELECT }> | null;
}

/**
 * Reads a household's {@link InviteAuthority} in one query. A missing
 * household reads as an empty roster with no policy, which no invite grant
 * matches; the caller's household lock answers it 404.
 */
export async function readInviteAuthority(
  client: Prisma.TransactionClient,
  householdId: string,
): Promise<InviteAuthority> {
  const household = await client.household.findUnique({
    where: { id: householdId },
    select: { settings: { select: INVITE_SETTINGS_SELECT }, members: { select: ROSTER_ROLE_SELECT } },
  });

  return { members: household?.members ?? [], settings: household?.settings ?? null };
}

/**
 * An invite into the household as the invite grants are asked about it: the
 * role it offers, whether it opens awaiting approval, and the household's
 * roster and policy. Sending one (#162) and accepting one (#747) ask about the
 * same instance, so a grant reads the sender's standing the same way at both.
 */
export function householdInviteSubject(
  householdId: string,
  role: AssignableHouseholdRole,
  needsApproval: boolean,
  { members, settings }: InviteAuthority,
) {
  return { householdId, needsApproval, role: { name: role }, household: { settings, members } };
}

/**
 * Whether an invite's sender could send it now (#747), asked of their own
 * ability as `tx` reads it, about the household's `authority` as the caller
 * read it under its household lock: their role on the roster and the member
 * invite policy as they stand now, not as they stood when they sent it. So an invite whose sender has left, been
 * banned, or lost the standing to offer its role admits nobody. That covers
 * an owner who has since handed over ownership (#169) and a member invite
 * policy tightened since.
 *
 * An invite sent to wait for an approver stands if they could still send it
 * either way, directly or for approval. One sent directly must be one they
 * could still open directly. The sender's graph is loaded once for both
 * questions.
 */
export async function senderCouldStillSend(
  abilities: AbilityService,
  tx: Prisma.TransactionClient,
  householdId: string,
  invite: { readonly inviterId: string; readonly role: AssignableHouseholdRole; readonly needsApproval: boolean },
  authority: InviteAuthority,
): Promise<boolean> {
  const senderCan = await abilities.userAbilityWithin(tx, invite.inviterId);

  const couldSend = (needsApproval: boolean) =>
    senderCan(
      Action.create,
      ResourceType.Invite,
      householdInviteSubject(householdId, invite.role, needsApproval, authority),
    );

  return couldSend(false) || (invite.needsApproval && couldSend(true));
}

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
 * staff read every invite through a wildcard grant, and a variant of a
 * shipped household role (#844) may hand a member extra permissions, but
 * neither makes them the household's owner or admin. An actor with no user,
 * such as a plugin actor, is never one.
 */
export function isHouseholdAuthority(members: readonly RosterRow[], userId: string | null): boolean {
  return (
    userId !== null &&
    members.some(
      (member) => member.userId === userId && HOUSEHOLD_AUTHORITY_ROLES.some((role) => role === member.role?.role.name),
    )
  );
}

/**
 * The role an invite offers, as an admission takes it and a sender check
 * asks about it (#747). The create stores only an assignable role, so another
 * is drift in the data: a server error, and nothing the invitee did. No role
 * is the seam's default, the least of them.
 */
export function offeredRole(invite: {
  readonly id: string;
  readonly role: { readonly name: string } | null;
}): AssignableHouseholdRole | undefined {
  const name = invite.role?.name;

  if (name === undefined) {
    return undefined;
  }

  if (!isAssignableHouseholdRole(name)) {
    throw new Error(`Invite ${invite.id} offers the role '${name}', which no household admission grants`);
  }

  return name;
}
