import type { EventAttendee, PermissionSlug, Prisma } from '@bge/database';
import { isOutOfEvent } from '../attendee/attendance';

/** The permission an event role needs for its attendee to vote on nominations (#759). */
export const GAME_VOTE_SLUG = 'create:event_game_vote' satisfies PermissionSlug;

/** The permission an event role needs for its attendee to vote on dates (#759). */
export const AVAILABILITY_VOTE_SLUG = 'create:event_availability_vote' satisfies PermissionSlug;

type VoteSlug = typeof GAME_VOTE_SLUG | typeof AVAILABILITY_VOTE_SLUG;

/**
 * What {@link canCastVote} reads of an attendee: their account, and whether
 * their event role holds the vote's permission.
 */
export interface VoterGrant {
  userId: string | null;
  role: { role: { permissions: { id: string }[] } } | null;
}

/**
 * Reads what {@link canCastVote} needs (#759): the attendee's account, and at
 * most one grant of `slug` to their event role whose permission isn't
 * retired and isn't a denial.
 *
 * The grant is read live, when the votes are counted, so the count follows a
 * grant the permission catalog or a server admin adds to or takes from a role
 * (#772). Which role holds it, and who added the edge, makes no difference.
 * A revoked grant confers nothing either: the Owner took it from the role
 * and the row stays so bootstrap doesn't give it back (#772). A retired
 * permission confers nothing. Nor does one an operator inverted:
 * the ability loader reads an inverted row as `cannot`, so its holder can't
 * cast the vote and mustn't count as able to.
 */
export function voterGrantSelect(slug: VoteSlug) {
  return {
    userId: true,
    role: {
      select: {
        role: {
          select: {
            permissions: {
              where: { revokedAt: null, permission: { is: { slug, retiredAt: null, inverted: false } } },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
    },
  } as const satisfies Prisma.EventAttendeeSelect;
}

/**
 * Whether an attendee can cast the vote {@link voterGrantSelect} read the
 * grant of (#759). An attendee without an account can never cast one, since
 * nobody acts as them. Neither can one whose event role doesn't hold the
 * vote, or who has no role. Not exported: a caller asks {@link countsAsVoter},
 * so no count can skip the check that the attendee is still in the event.
 */
function canCastVote(attendee: VoterGrant): boolean {
  return attendee.userId !== null && (attendee.role?.role.permissions.length ?? 0) > 0;
}

/**
 * Whether an attendee's vote counts, before any rule an event's policy adds:
 * they are in the event (#551), and they can cast the vote (#759). Every
 * count and every vote's mark starts here, so none of them disagrees about
 * who votes.
 */
export function countsAsVoter(attendee: VoterGrant & Pick<EventAttendee, 'removedAt' | 'status'>): boolean {
  return !isOutOfEvent(attendee) && canCastVote(attendee);
}
