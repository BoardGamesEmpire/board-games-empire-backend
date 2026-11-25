import type { Prisma } from '@bge/database';
import { HUMAN_USER_WHERE, InviteType } from '@bge/database';
import { t } from '@bge/i18n';
import { gateInvitee } from '@bge/invites';
import { NotFoundException } from '@nestjs/common';

/**
 * Asserts the inviter may invite each user to an event by id (#546, #742), in
 * the caller's transaction, before anything is written. Both ways of doing it
 * ask, through `inviteWithin`: the event's create, with its `inviteUserIds`,
 * and the invite route, so a refusal on one cannot be had on the other a
 * request later.
 *
 * 1. The id names a person: an account that is neither the server's service
 *    account nor an anonymous user. Otherwise 404, as an invite by id
 *    answers (#162), and the insert never sees an unknown id.
 * 2. The checks an invite to a household makes (#278), on the event's own
 *    settings: the server's policy, a block between the two, and the user's
 *    own preference. Otherwise 403.
 *
 * In the order given, so the first refusal is the one answered. Placing
 * yourself is no invite, so the inviter's own id is not asked about.
 */
export async function assertInvitable(
  tx: Prisma.TransactionClient,
  inviterId: string,
  userIds: readonly string[],
): Promise<void> {
  for (const userId of userIds) {
    if (userId === inviterId) {
      continue;
    }

    const user = await tx.user.findUnique({ where: { id: userId, ...HUMAN_USER_WHERE }, select: { id: true } });

    if (!user) {
      throw new NotFoundException(t('errors.user.not_found', { id: userId }));
    }

    await gateInvitee(tx, InviteType.Event, inviterId, { inviteeId: user.id, inviteeEmail: null });
  }
}
