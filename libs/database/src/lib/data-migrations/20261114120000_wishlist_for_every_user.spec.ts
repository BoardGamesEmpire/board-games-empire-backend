import type { Logger } from '@nestjs/common';
import type { Prisma } from '../client';
import { PROVISIONED_HUMAN_WHERE } from '../utils/human-user';
import { wishlistForEveryUser } from './20261114120000_wishlist_for_every_user';

describe('wishlistForEveryUser', () => {
  it('is the ledger entry named for its migration, at revision 1 (#1241)', () => {
    expect(wishlistForEveryUser.name).toBe('20261114120000_wishlist_for_every_user');
    expect(wishlistForEveryUser.revision).toBe(1);
  });

  it(
    'gives each provisioned person without a wishlist one, and leaves anonymous users, the service account ' +
      'and existing wishlists alone (#1241)',
    async () => {
      const tx = {
        user: { findMany: jest.fn().mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]) },
        list: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
      };
      const logger = { log: jest.fn() } as unknown as Logger;

      await wishlistForEveryUser.run(tx as unknown as Prisma.TransactionClient, logger);

      // The people filter is the one provisioning uses, so anonymous users and the service account fall outside it.
      expect(tx.user.findMany).toHaveBeenCalledWith({
        where: { ...PROVISIONED_HUMAN_WHERE, lists: { none: { kind: 'Wishlist' } } },
        select: { id: true },
      });
      expect(tx.list.createMany).toHaveBeenCalledWith({
        data: [
          { userId: 'u1', kind: 'Wishlist' },
          { userId: 'u2', kind: 'Wishlist' },
        ],
      });
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('2'));
    },
  );

  it('writes nothing when everyone already has a wishlist (#1241)', async () => {
    const tx = {
      user: { findMany: jest.fn().mockResolvedValue([]) },
      list: { createMany: jest.fn() },
    };

    await wishlistForEveryUser.run(tx as unknown as Prisma.TransactionClient, { log: jest.fn() } as unknown as Logger);

    expect(tx.list.createMany).not.toHaveBeenCalled();
  });
});
