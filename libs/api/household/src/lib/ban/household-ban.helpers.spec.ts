import { Prisma } from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { addressHolderBannedWithin, isBannedWithin } from './household-ban.helpers';

const asTx = (mock: MockDatabaseService): Prisma.TransactionClient => mock as unknown as Prisma.TransactionClient;

describe('household ban helpers (#782)', () => {
  let tx: MockDatabaseService;

  beforeEach(() => {
    tx = createMockDatabaseService();
  });

  it('isBannedWithin looks the household and user pair up by its unique key (#782)', async () => {
    tx.householdBan.findUnique.mockResolvedValueOnce({ id: 'ban-1' } as never).mockResolvedValueOnce(null);

    await expect(isBannedWithin(asTx(tx), 'hh-1', 'user-2')).resolves.toBe(true);
    await expect(isBannedWithin(asTx(tx), 'hh-1', 'user-3')).resolves.toBe(false);

    expect(tx.householdBan.findUnique).toHaveBeenNthCalledWith(1, {
      where: { householdId_userId: { householdId: 'hh-1', userId: 'user-2' } },
      select: { id: true },
    });
    expect(tx.householdBan.findUnique).toHaveBeenNthCalledWith(2, {
      where: { householdId_userId: { householdId: 'hh-1', userId: 'user-3' } },
      select: { id: true },
    });
  });

  it('addressHolderBannedWithin matches the address lower-cased and trimmed (#782)', async () => {
    tx.householdBan.count.mockResolvedValue(1);

    await expect(addressHolderBannedWithin(asTx(tx), 'hh-1', ' Banned@Example.com')).resolves.toBe(true);

    // Exact, never `mode: 'insensitive'`: that is ILIKE, where `_` and `%` in
    // an address are wildcards. Addresses are stored lower-cased.
    expect(tx.householdBan.count).toHaveBeenCalledWith({
      where: { householdId: 'hh-1', user: { is: { email: 'banned@example.com' } } },
    });
  });

  it('addressHolderBannedWithin finds no ban for an address no banned user holds (#782)', async () => {
    tx.householdBan.count.mockResolvedValue(0);

    await expect(addressHolderBannedWithin(asTx(tx), 'hh-1', 'someone@example.com')).resolves.toBe(false);
  });
});
