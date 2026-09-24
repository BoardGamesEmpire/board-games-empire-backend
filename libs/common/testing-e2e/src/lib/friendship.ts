import { FriendshipStatus, type PrismaClient } from '@bge/database';
import type { AuthenticatedActor } from './types.js';

/**
 * An accepted friendship between two actors, arranged directly in the
 * database. `pairKey` is the canonical undirected key the model requires the
 * service to maintain — the two ids sorted and joined — so a row written here
 * is indistinguishable from one the friendship service would have written.
 *
 * Extracted when a second suite needed it (#484), on the concrete-first rule
 * `apps/api-e2e/src/support/wire.ts` describes.
 */
export async function befriend(
  prisma: PrismaClient,
  a: Pick<AuthenticatedActor, 'user'>,
  b: Pick<AuthenticatedActor, 'user'>,
): Promise<void> {
  await prisma.friendship.create({
    data: {
      requesterId: a.user.id,
      addresseeId: b.user.id,
      pairKey: [a.user.id, b.user.id].sort().join(':'),
      status: FriendshipStatus.Accepted,
      respondedAt: new Date(),
    },
  });
}
