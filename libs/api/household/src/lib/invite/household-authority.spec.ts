import type { Prisma } from '@bge/database';
import { createMockDatabaseService } from '@bge/testing';
import { readInviteAuthority } from './household-authority';

describe('readInviteAuthority (#747)', () => {
  it('reads a missing household as an empty roster with no policy, which no invite grant matches', async () => {
    const db = createMockDatabaseService();
    db.household.findUnique.mockResolvedValue(null as never);

    await expect(readInviteAuthority(db as unknown as Prisma.TransactionClient, 'hh-gone')).resolves.toEqual({
      members: [],
      settings: null,
    });
  });
});
