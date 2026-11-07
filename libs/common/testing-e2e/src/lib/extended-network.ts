import type { PrismaClient } from '@bge/database';
import type { AuthenticatedActor } from './types.js';

/**
 * Two actors in each other's extended network, a number of friendship steps
 * apart, arranged directly in the extended network table in both directions, as the
 * worker job writes a pair (#497). It stands in for the job, as
 * `arrangeFriendship` stands in for the friendship service, so a suite about
 * what the permissions let in needs neither a worker nor a chain of
 * friendships.
 *
 * It writes no friendship. A block a test arranges beside it is the
 * friendship row the permissions veto on, which the job never stores here.
 */
export async function arrangeExtendedNetwork(
  prisma: PrismaClient,
  a: Pick<AuthenticatedActor, 'user'>,
  b: Pick<AuthenticatedActor, 'user'>,
  steps: 1 | 2 | 3,
): Promise<void> {
  await prisma.extendedNetwork.createMany({
    data: [
      { userId: a.user.id, otherUserId: b.user.id, steps },
      { userId: b.user.id, otherUserId: a.user.id, steps },
    ],
  });
}
