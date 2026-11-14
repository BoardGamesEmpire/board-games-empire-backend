import { ListKind } from '../client';
import { PROVISIONED_HUMAN_WHERE } from '../utils/human-user';
import type { DataMigrationEntry } from './data-migration-entry';

/**
 * Gives every registered user who has none a wishlist (#1241); provisioning
 * does the same for each user who signs up after this ships.
 *
 * The same people filter as the Owner election: provisioned humans, so
 * anonymous users and the service account get none. A user who somehow
 * already holds a wishlist is skipped, which the one-wishlist-per-user index
 * would otherwise refuse.
 *
 * Written through Prisma rather than SQL because a list's id is a cuid2 that
 * Prisma mints and SQL cannot. The wishlist has no name (a client shows its
 * own translated "Wishlist") and the default reach, private.
 */
export const wishlistForEveryUser: DataMigrationEntry = {
  name: '20261114120000_wishlist_for_every_user',
  revision: 1,
  async run(tx, logger) {
    const users = await tx.user.findMany({
      where: { ...PROVISIONED_HUMAN_WHERE, lists: { none: { kind: ListKind.Wishlist } } },
      select: { id: true },
    });

    if (users.length > 0) {
      await tx.list.createMany({ data: users.map(({ id }) => ({ userId: id, kind: ListKind.Wishlist })) });
    }

    logger.log(`Gave ${users.length} user(s) a wishlist.`);
  },
};
