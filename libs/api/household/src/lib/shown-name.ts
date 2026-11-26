import type { Prisma } from '@bge/database';

/** What {@link shownName} reads of a user. */
export const SHOWN_NAME_SELECT = {
  username: true,
  profile: { select: { displayName: true } },
} as const satisfies Prisma.UserSelect;

/**
 * A user's name as it is shown: their display name, or their username when
 * the display name is unset or blank. The household's and the event's invite
 * routes name an invitee by it (the household's when the inviter gives no
 * name), and the household's and the event's notifications name everyone by
 * it (#742), so none of them can drift apart.
 */
export function shownName(user: Prisma.UserGetPayload<{ select: typeof SHOWN_NAME_SELECT }>): string {
  return user.profile?.displayName || user.username;
}
