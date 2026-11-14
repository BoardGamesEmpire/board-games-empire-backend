import { PlatformType, type Prisma } from '@bge/database';
import { t } from '@bge/i18n';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import {
  assertPolicyReferencesExist,
  changedPolicyLists,
  replaceEventPolicyLists,
  replaceOccurrencePolicyLists,
} from './policy-lists';

const asTx = (mock: MockDatabaseService): Prisma.TransactionClient => mock as unknown as Prisma.TransactionClient;

describe('assertPolicyReferencesExist', () => {
  let tx: MockDatabaseService;

  beforeEach(() => {
    tx = createMockDatabaseService();
    // Every id asked about names a row, and the count is of rows, as
    // Postgres counts them: an id asked about twice matches one.
    const countIds = (args: { where: { id: { in: string[] } } }) => Promise.resolve(new Set(args.where.id.in).size);
    tx.platform.count.mockImplementation(countIds as never);
    tx.category.count.mockImplementation(countIds as never);
  });

  // The count is of distinct rows, so an id sent twice is counted once on
  // both sides, and a known id is not taken for an unknown one (#1268).
  it('counts an id sent twice once, so it is not refused as unknown (#1268)', async () => {
    await expect(
      assertPolicyReferencesExist(asTx(tx), { platformIds: ['plat-1', 'plat-1'], categoryIds: ['cat-1', 'cat-1'] }),
    ).resolves.toBeUndefined();

    expect(tx.platform.count).toHaveBeenCalledWith({ where: { id: { in: ['plat-1'] } } });
    expect(tx.category.count).toHaveBeenCalledWith({ where: { id: { in: ['cat-1'] } } });
  });

  it('refuses a platform id that names no platform (#1268)', async () => {
    tx.platform.count.mockResolvedValue(1 as never);

    await expect(assertPolicyReferencesExist(asTx(tx), { platformIds: ['plat-1', 'nope'] })).rejects.toMatchObject({
      status: 400,
      response: { code: 'EVENT_POLICY_UNKNOWN_REFERENCE', message: t('errors.event_policy.unknown_platform') },
    });
  });

  it('refuses a category id that names no category (#1268)', async () => {
    tx.category.count.mockResolvedValue(0 as never);

    await expect(assertPolicyReferencesExist(asTx(tx), { categoryIds: ['nope'] })).rejects.toMatchObject({
      status: 400,
      response: { code: 'EVENT_POLICY_UNKNOWN_REFERENCE', message: t('errors.event_policy.unknown_category') },
    });
  });

  it('asks nothing when no id is sent, an empty list included (#1268)', async () => {
    await assertPolicyReferencesExist(asTx(tx), { platformIds: [] });

    expect(tx.platform.count).not.toHaveBeenCalled();
    expect(tx.category.count).not.toHaveBeenCalled();
  });
});

describe('changedPolicyLists', () => {
  const stored = {
    allowedPlatformTypes: [PlatformType.Tabletop],
    allowedPlatformIds: ['plat-1', 'plat-2'],
    allowedCategoryIds: ['cat-1'],
  };

  // A form that re-sends what it loaded, in whatever order, changes nothing (#728, #1268).
  it('finds no change in a list re-sent with the same members in another order, or in one left out (#1268)', () => {
    expect(changedPolicyLists(stored, { allowedPlatformIds: ['plat-2', 'plat-1', 'plat-2'] })).toEqual({
      before: {},
      after: {},
    });
  });

  // Both sides deduplicated and sorted, as the lists are stored and served,
  // so an audit row's before and after compare by value (#1268).
  it('gives each changed list as it was and as it will be stored, deduplicated and sorted (#1268)', () => {
    expect(
      changedPolicyLists(stored, {
        allowedPlatformTypes: [PlatformType.Tabletop, PlatformType.PC, PlatformType.Tabletop],
        allowedPlatformIds: ['plat-1', 'plat-2'],
        allowedCategoryIds: [],
      }),
    ).toEqual({
      before: { allowedPlatformTypes: [PlatformType.Tabletop], allowedCategoryIds: ['cat-1'] },
      after: { allowedPlatformTypes: [PlatformType.PC, PlatformType.Tabletop], allowedCategoryIds: [] },
    });
  });
});

describe('replacing the lists', () => {
  let tx: MockDatabaseService;

  beforeEach(() => {
    tx = createMockDatabaseService();
  });

  it("replaces each of an event policy's lists given, once per member, and leaves the rest (#1268)", async () => {
    await replaceEventPolicyLists(asTx(tx), 'policy-1', {
      allowedPlatformIds: ['plat-1', 'plat-1'],
      allowedCategoryIds: [],
    });

    expect(tx.eventPolicyPlatform.deleteMany).toHaveBeenCalledWith({ where: { eventPolicyId: 'policy-1' } });
    expect(tx.eventPolicyPlatform.createMany).toHaveBeenCalledWith({
      data: [{ eventPolicyId: 'policy-1', platformId: 'plat-1' }],
    });
    expect(tx.eventPolicyCategory.deleteMany).toHaveBeenCalledWith({ where: { eventPolicyId: 'policy-1' } });
    expect(tx.eventPolicyCategory.createMany).toHaveBeenCalledWith({ data: [] });
    expect(tx.eventPolicyPlatformType.deleteMany).not.toHaveBeenCalled();
  });

  // An empty list on a date is the event's, so clearing one hands it back (#796, #1268).
  it("replaces each of a date policy's lists given, once per member, and leaves the rest (#796)", async () => {
    await replaceOccurrencePolicyLists(asTx(tx), 'occ-policy-1', {
      allowedPlatformTypes: [PlatformType.Console, PlatformType.Console],
      allowedPlatformIds: ['plat-1'],
      allowedCategoryIds: [],
    });

    expect(tx.occurrencePolicyPlatformType.deleteMany).toHaveBeenCalledWith({
      where: { occurrencePolicyId: 'occ-policy-1' },
    });
    expect(tx.occurrencePolicyPlatformType.createMany).toHaveBeenCalledWith({
      data: [{ occurrencePolicyId: 'occ-policy-1', platformType: PlatformType.Console }],
    });
    expect(tx.occurrencePolicyPlatform.createMany).toHaveBeenCalledWith({
      data: [{ occurrencePolicyId: 'occ-policy-1', platformId: 'plat-1' }],
    });
    expect(tx.occurrencePolicyCategory.deleteMany).toHaveBeenCalledWith({
      where: { occurrencePolicyId: 'occ-policy-1' },
    });
    expect(tx.occurrencePolicyCategory.createMany).toHaveBeenCalledWith({ data: [] });
  });

  it('writes nothing for a list left out (#796)', async () => {
    await replaceOccurrencePolicyLists(asTx(tx), 'occ-policy-1', {});

    expect(tx.occurrencePolicyPlatformType.deleteMany).not.toHaveBeenCalled();
    expect(tx.occurrencePolicyPlatform.deleteMany).not.toHaveBeenCalled();
    expect(tx.occurrencePolicyCategory.deleteMany).not.toHaveBeenCalled();
  });
});
