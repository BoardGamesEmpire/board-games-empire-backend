import { PlatformType, Prisma, VocabularyLinkOrigin, VocabularyLinkStatus } from '@bge/database';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { VocabularyLinkService } from './vocabulary-link.service';

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });

const REVIEW_OFF = { reviewGatewayPlatforms: false, reviewGatewayCategories: false, reviewGatewayMechanics: false };
const REVIEW_ON = { reviewGatewayPlatforms: true, reviewGatewayCategories: true, reviewGatewayMechanics: true };

const GW = 'gw-1';

const PC = { externalId: '6', name: 'PC (Microsoft Windows)', abbreviation: 'PC', platformType: PlatformType.PC };
const TABLETOP = { externalId: 'tabletop', name: 'Tabletop', platformType: PlatformType.Tabletop };
const STRATEGY = { externalId: '15', name: 'Strategy' };
const WORKER_PLACEMENT = { externalId: '2082', name: 'Worker Placement' };

/** As Prisma answers a create-only upsert that wrote its row: the row as written. */
const asWritten =
  (recordKey: 'platformId' | 'categoryId' | 'mechanicId' | 'familyId') =>
  async (args: { create: Record<string, unknown> }) => ({
    status: args.create['status'] ?? VocabularyLinkStatus.Resolved,
    [recordKey]: args.create[recordKey],
  });

describe('VocabularyLinkService', () => {
  let service: VocabularyLinkService;
  let db: MockDatabaseService;

  beforeEach(async () => {
    const testing = await createTestingModuleWithDb({ providers: [VocabularyLinkService] });

    db = testing.db;
    service = testing.module.get(VocabularyLinkService);

    // Defaults: review off, no links, no records, nothing similar, writes succeed.
    db.systemSetting.findFirst.mockResolvedValue(REVIEW_OFF as never);
    for (const table of [
      db.platformGatewayLink,
      db.categoryGatewayLink,
      db.mechanicGatewayLink,
      db.familyGatewayLink,
    ]) {
      table.findUnique.mockResolvedValue(null);
      table.updateMany.mockResolvedValue({ count: 1 } as never);
    }
    db.platformGatewayLink.upsert.mockImplementation(asWritten('platformId') as never);
    db.categoryGatewayLink.upsert.mockImplementation(asWritten('categoryId') as never);
    db.mechanicGatewayLink.upsert.mockImplementation(asWritten('mechanicId') as never);
    db.familyGatewayLink.upsert.mockImplementation(asWritten('familyId') as never);
    for (const table of [db.platform, db.category, db.mechanic, db.family]) {
      table.findUnique.mockResolvedValue(null);
      table.create.mockResolvedValue({ id: 'record-new' } as never);
    }
    db.$queryRaw.mockResolvedValue([] as never);
  });

  afterEach(() => jest.clearAllMocks());

  /** No write reached any vocabulary table. */
  const expectNoWrites = () => {
    for (const table of [
      db.platformGatewayLink,
      db.categoryGatewayLink,
      db.mechanicGatewayLink,
      db.familyGatewayLink,
    ]) {
      expect(table.upsert).not.toHaveBeenCalled();
      expect(table.update).not.toHaveBeenCalled();
      expect(table.updateMany).not.toHaveBeenCalled();
    }
    for (const table of [db.platform, db.category, db.mechanic, db.family]) {
      expect(table.create).not.toHaveBeenCalled();
    }
  };

  describe('an existing link', () => {
    it('returns the linked record for a Resolved link, without matching again', async () => {
      db.categoryGatewayLink.findUnique.mockResolvedValue({
        status: VocabularyLinkStatus.Resolved,
        categoryId: 'cat-1',
      } as never);

      await expect(service.resolveForImport('category', GW, STRATEGY)).resolves.toBe('cat-1');

      expect(db.categoryGatewayLink.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { gatewayId_externalId: { gatewayId: GW, externalId: '15' } } }),
      );
      expect(db.category.findUnique).not.toHaveBeenCalled();
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expectNoWrites();
    });

    it.each([VocabularyLinkStatus.Pending, VocabularyLinkStatus.Ignored])(
      'returns null for a %s link at import, and never rewrites it (#715)',
      async (status) => {
        db.mechanicGatewayLink.findUnique.mockResolvedValue({ status, mechanicId: null } as never);

        await expect(service.resolveForImport('mechanic', GW, WORKER_PLACEMENT)).resolves.toBeNull();

        expect(db.mechanic.findUnique).not.toHaveBeenCalled();
        expectNoWrites();
      },
    );

    it('keeps an existing link of any status when a list job meets it again', async () => {
      db.platformGatewayLink.findUnique
        .mockResolvedValueOnce({ status: VocabularyLinkStatus.Resolved, platformId: 'p-1' } as never)
        .mockResolvedValueOnce({ status: VocabularyLinkStatus.Pending, platformId: null } as never)
        .mockResolvedValueOnce({ status: VocabularyLinkStatus.Ignored, platformId: null } as never);

      const summary = await service.load('platform', GW, [PC, TABLETOP, { ...PC, externalId: '7' }]);

      expect(summary).toEqual({ created: 0, matched: 0, pending: 0, kept: 3 });
      expectNoWrites();
    });
  });

  describe('matching', () => {
    it('links a listed platform to the record whose slug matches, such as the seeded Tabletop', async () => {
      db.platform.findUnique.mockResolvedValue({ id: 'platform-tabletop' } as never);

      const summary = await service.load('platform', GW, [TABLETOP]);

      expect(db.platform.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { slug: 'tabletop' } }));
      expect(db.platformGatewayLink.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { gatewayId_externalId: { gatewayId: GW, externalId: 'tabletop' } },
          create: expect.objectContaining({
            platformId: 'platform-tabletop',
            status: VocabularyLinkStatus.Resolved,
            origin: VocabularyLinkOrigin.Interview,
          }),
          update: {},
        }),
      );
      expect(db.platform.create).not.toHaveBeenCalled();
      expect(summary).toEqual({ created: 0, matched: 1, pending: 0, kept: 0 });
    });

    it('links a category to a record of similar name, but never matches a platform by similarity', async () => {
      db.$queryRaw.mockResolvedValue([{ id: 'cat-similar' }] as never);

      await expect(service.resolveForImport('category', GW, STRATEGY)).resolves.toBe('cat-similar');
      expect(db.categoryGatewayLink.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ categoryId: 'cat-similar' }) }),
      );
      expect(db.category.create).not.toHaveBeenCalled();

      db.$queryRaw.mockClear();
      await expect(service.resolveForImport('platform', GW, PC)).resolves.toBe('record-new');
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(db.platform.create).toHaveBeenCalledTimes(1);
    });

    it('links to the winner when another writer creates the same slug first', async () => {
      db.category.findUnique
        .mockResolvedValueOnce(null) // the slug misses
        .mockResolvedValueOnce({ id: 'cat-raced' } as never); // the winner, read again after the race
      db.category.create.mockRejectedValue(uniqueViolation());

      await expect(service.resolveForImport('category', GW, STRATEGY)).resolves.toBe('cat-raced');

      expect(db.categoryGatewayLink.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ categoryId: 'cat-raced', status: VocabularyLinkStatus.Resolved }),
          update: {},
        }),
      );
    });

    // An import and a list job can meet the same entry at once. When the race
    // was on the link, not the slug, the link the other writer made decides.
    it('answers with the link another writer created first, when the race was on the link', async () => {
      db.categoryGatewayLink.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ status: VocabularyLinkStatus.Pending, categoryId: null } as never);
      db.category.create.mockRejectedValue(uniqueViolation());

      await expect(service.resolveForImport('category', GW, STRATEGY)).resolves.toBeNull();
      expect(db.categoryGatewayLink.upsert).not.toHaveBeenCalled();
    });

    // Two entries of one list whose names slug the same, such as "Sci-Fi"
    // and "Sci Fi", share a record: the second finds the first's (#718).
    it('links an entry to the record another entry of the same list just created under its slug', async () => {
      db.category.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'record-new' } as never);

      const summary = await service.load('category', GW, [
        { externalId: '1', name: 'Sci-Fi' },
        { externalId: '2', name: 'Sci Fi' },
      ]);

      expect(db.category.create).toHaveBeenCalledTimes(1);
      expect(db.categoryGatewayLink.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ externalId: '2', categoryId: 'record-new' }) }),
      );
      expect(summary).toEqual({ created: 1, matched: 1, pending: 0, kept: 0 });
    });

    it('answers with the link another writer made first, as it stands', async () => {
      db.category.findUnique.mockResolvedValue({ id: 'cat-1' } as never);
      db.categoryGatewayLink.upsert.mockResolvedValue({
        status: VocabularyLinkStatus.Ignored,
        categoryId: null,
      } as never);

      await expect(service.resolveForImport('category', GW, STRATEGY)).resolves.toBeNull();
    });
  });

  describe('a miss', () => {
    it('creates the record and its Resolved link in one write when nothing matches', async () => {
      const summary = await service.load('category', GW, [{ externalId: '15', name: 'Café Strategy' }]);

      expect(db.category.create).toHaveBeenCalledTimes(1);
      expect(db.category.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            name: 'Café Strategy',
            slug: 'cafe-strategy',
            gatewayLinks: {
              create: {
                gatewayId: GW,
                externalId: '15',
                suppliedName: 'Café Strategy',
                status: VocabularyLinkStatus.Resolved,
                origin: VocabularyLinkOrigin.Interview,
              },
            },
          },
        }),
      );
      expect(db.categoryGatewayLink.upsert).not.toHaveBeenCalled();
      expect(summary).toEqual({ created: 1, matched: 0, pending: 0, kept: 0 });
    });

    it('stores the supplied name, abbreviation and platform type on a platform link', async () => {
      await service.resolveForImport('platform', GW, PC);

      expect(db.platform.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            name: 'PC (Microsoft Windows)',
            slug: 'pc-microsoft-windows',
            abbreviation: 'PC',
            platformType: PlatformType.PC,
            gatewayLinks: {
              create: {
                gatewayId: GW,
                externalId: '6',
                status: VocabularyLinkStatus.Resolved,
                origin: VocabularyLinkOrigin.Import,
                suppliedName: 'PC (Microsoft Windows)',
                suppliedAbbreviation: 'PC',
                suppliedPlatformType: PlatformType.PC,
              },
            },
          },
        }),
      );

      db.platform.findUnique.mockResolvedValue({ id: 'platform-pc' } as never);
      await service.resolveForImport('platform', GW, { ...TABLETOP, externalId: 'tt', name: 'PC' });

      expect(db.platformGatewayLink.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            suppliedName: 'PC',
            suppliedAbbreviation: null,
            suppliedPlatformType: PlatformType.Tabletop,
          }),
        }),
      );
    });

    it('parks a miss as Pending with no record while that kind’s review setting is on', async () => {
      db.systemSetting.findFirst.mockResolvedValue({ ...REVIEW_OFF, reviewGatewayMechanics: true } as never);

      await expect(service.resolveForImport('mechanic', GW, WORKER_PLACEMENT)).resolves.toBeNull();

      expect(db.mechanicGatewayLink.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: {
            gatewayId: GW,
            externalId: '2082',
            suppliedName: 'Worker Placement',
            mechanicId: null,
            status: VocabularyLinkStatus.Pending,
            origin: VocabularyLinkOrigin.Import,
          },
          update: {},
        }),
      );
      expect(db.mechanic.create).not.toHaveBeenCalled();
    });

    it('creates the record while another kind’s review setting is on', async () => {
      db.systemSetting.findFirst.mockResolvedValue({ ...REVIEW_ON, reviewGatewayCategories: false } as never);

      await expect(service.resolveForImport('category', GW, STRATEGY)).resolves.toBe('record-new');
      expect(db.category.create).toHaveBeenCalledTimes(1);
    });

    it('never parks a family: families have no review setting', async () => {
      db.systemSetting.findFirst.mockResolvedValue(REVIEW_ON as never);

      await expect(service.resolveForImport('family', GW, { externalId: '3', name: 'Catan' })).resolves.toBe(
        'record-new',
      );

      expect(db.family.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            name: 'Catan',
            slug: 'catan',
            gatewayLinks: { create: { gatewayId: GW, externalId: '3', externalName: 'Catan' } },
          },
        }),
      );
      expect(db.familyGatewayLink.upsert).not.toHaveBeenCalled();
    });

    it('rethrows a failed create that no other writer explains', async () => {
      const boom = new Error('connection reset');
      db.category.create.mockRejectedValue(boom);

      await expect(service.resolveForImport('category', GW, STRATEGY)).rejects.toBe(boom);
      expect(db.category.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('load', () => {
    it('reads the review setting once for the whole list', async () => {
      await service.load('mechanic', GW, [WORKER_PLACEMENT, { externalId: '2', name: 'Dice Rolling' }]);

      expect(db.systemSetting.findFirst).toHaveBeenCalledTimes(1);
    });

    it('skips an entry with a blank external id or name, and links the rest', async () => {
      const summary = await service.load('category', GW, [
        { externalId: ' ', name: 'Strategy' },
        { externalId: '16', name: '' },
        STRATEGY,
      ]);

      expect(db.category.create).toHaveBeenCalledTimes(1);
      expect(summary).toEqual({ created: 1, matched: 0, pending: 0, kept: 0 });
    });

    it('starts no write once the signal aborts, and throws its reason', async () => {
      const abandonment = new AbortController();
      const reason = new Error('the connection was replaced');
      db.category.create.mockImplementation((async () => {
        abandonment.abort(reason);
        return { id: 'record-new' };
      }) as never);

      await expect(
        service.load('category', GW, [STRATEGY, { externalId: '16', name: 'Abstract' }], abandonment.signal),
      ).rejects.toBe(reason);

      expect(db.categoryGatewayLink.findUnique).toHaveBeenCalledTimes(1);
      expect(db.category.findUnique).toHaveBeenCalledTimes(1);
      expect(db.category.create).toHaveBeenCalledTimes(1);
    });

    it('starts no write once the signal aborts during a read', async () => {
      const abandonment = new AbortController();
      const reason = new Error('the connection was replaced');
      db.category.findUnique.mockImplementation((async () => {
        abandonment.abort(reason);
        return { id: 'cat-1' };
      }) as never);

      await expect(service.load('category', GW, [STRATEGY], abandonment.signal)).rejects.toBe(reason);

      expectNoWrites();
    });
  });

  describe('acceptPending', () => {
    const pendingPlatform = {
      status: VocabularyLinkStatus.Pending,
      suppliedName: 'PC (Microsoft Windows)',
      suppliedAbbreviation: 'PC',
      suppliedPlatformType: PlatformType.PC,
    };

    it('accepts a Pending link by creating its record from the supplied fields', async () => {
      db.platformGatewayLink.findUnique.mockResolvedValue(pendingPlatform as never);
      db.platform.create.mockResolvedValue({ id: 'platform-new' } as never);

      await expect(service.acceptPending('platform', 'link-1')).resolves.toEqual({
        accepted: true,
        recordId: 'platform-new',
      });

      expect(db.platformGatewayLink.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'link-1' } }),
      );
      // The Pending link holds the DataGateway's key, so the record is made
      // on its own and the link then settled.
      expect(db.platform.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            name: 'PC (Microsoft Windows)',
            slug: 'pc-microsoft-windows',
            abbreviation: 'PC',
            platformType: PlatformType.PC,
          },
        }),
      );
      expect(db.platformGatewayLink.updateMany).toHaveBeenCalledWith({
        where: { id: 'link-1', status: VocabularyLinkStatus.Pending },
        data: { status: VocabularyLinkStatus.Resolved, platformId: 'platform-new' },
      });
    });

    it('accepts by linking to a record created since it was parked', async () => {
      db.categoryGatewayLink.findUnique.mockResolvedValue({
        status: VocabularyLinkStatus.Pending,
        suppliedName: 'Strategy',
      } as never);
      db.category.findUnique.mockResolvedValue({ id: 'cat-since' } as never);

      await expect(service.acceptPending('category', 'link-1')).resolves.toEqual({
        accepted: true,
        recordId: 'cat-since',
      });

      expect(db.category.create).not.toHaveBeenCalled();
      expect(db.categoryGatewayLink.updateMany).toHaveBeenCalledWith({
        where: { id: 'link-1', status: VocabularyLinkStatus.Pending },
        data: { status: VocabularyLinkStatus.Resolved, categoryId: 'cat-since' },
      });
    });

    it('accepts even while review is on: accepting is the review', async () => {
      db.systemSetting.findFirst.mockResolvedValue(REVIEW_ON as never);
      db.mechanicGatewayLink.findUnique.mockResolvedValue({
        status: VocabularyLinkStatus.Pending,
        suppliedName: 'Worker Placement',
      } as never);

      await expect(service.acceptPending('mechanic', 'link-1')).resolves.toEqual({
        accepted: true,
        recordId: 'record-new',
      });
    });

    it('refuses a link that is no longer Pending, as read', async () => {
      db.mechanicGatewayLink.findUnique.mockResolvedValue({
        status: VocabularyLinkStatus.Ignored,
        suppliedName: 'Worker Placement',
      } as never);

      await expect(service.acceptPending('mechanic', 'link-1')).resolves.toEqual({
        accepted: false,
        reason: 'not_pending',
      });
      expectNoWrites();
    });

    it('refuses a link that an admin settled while it was accepted', async () => {
      db.mechanicGatewayLink.findUnique.mockResolvedValue({
        status: VocabularyLinkStatus.Pending,
        suppliedName: 'Worker Placement',
      } as never);
      db.mechanicGatewayLink.updateMany.mockResolvedValue({ count: 0 } as never);

      await expect(service.acceptPending('mechanic', 'link-1')).resolves.toEqual({
        accepted: false,
        reason: 'not_pending',
      });
    });

    it('refuses a link that does not exist', async () => {
      await expect(service.acceptPending('category', 'link-gone')).resolves.toEqual({
        accepted: false,
        reason: 'not_pending',
      });
      expectNoWrites();
    });
  });
});
