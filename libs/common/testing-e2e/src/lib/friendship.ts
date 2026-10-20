import { FriendshipStatus, type PrismaClient } from '@bge/database';
import type { AuthenticatedActor } from './types.js';

/**
 * A friendship in any state, arranged directly in the database. `pairKey` is
 * the canonical undirected key the model requires the service to maintain —
 * the two ids sorted and joined — so a row written here is indistinguishable
 * from one the friendship service would have written. A pending request has
 * no answer yet, so only it is left without `respondedAt`. The requester is
 * the user who asked, or, for a block, the user who blocked.
 */
export async function arrangeFriendship(
  prisma: PrismaClient,
  requester: Pick<AuthenticatedActor, 'user'>,
  addressee: Pick<AuthenticatedActor, 'user'>,
  status: FriendshipStatus,
): Promise<void> {
  await prisma.friendship.create({
    data: {
      requesterId: requester.user.id,
      addresseeId: addressee.user.id,
      pairKey: [requester.user.id, addressee.user.id].sort().join(':'),
      status,
      respondedAt: status === FriendshipStatus.Pending ? null : new Date(),
    },
  });
}

/**
 * An accepted friendship between two actors.
 *
 * Extracted when a second suite needed it (#484), on the concrete-first rule
 * `apps/api-e2e/src/support/wire.ts` describes.
 */
export async function befriend(
  prisma: PrismaClient,
  a: Pick<AuthenticatedActor, 'user'>,
  b: Pick<AuthenticatedActor, 'user'>,
): Promise<void> {
  await arrangeFriendship(prisma, a, b, FriendshipStatus.Accepted);
}
