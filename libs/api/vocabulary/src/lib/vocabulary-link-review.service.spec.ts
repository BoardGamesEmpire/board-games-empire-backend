import { PlatformType, Prisma, VocabularyLinkOrigin, VocabularyLinkStatus } from '@bge/database';
import { t } from '@bge/i18n';
import { batchTransactionCall, createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DEFAULT_VOCABULARY_REVIEW_STATUSES, VocabularyLinkReviewService } from './vocabulary-link-review.service';
import { VocabularyLinkService } from './vocabulary-link.service';
import type { ReviewedVocabularyKind, VocabularyLinkView } from './vocabulary.types';

const GW = 'gw-1';
const AT = new Date('2026-10-01T12:00:00.000Z');
const RECORD = { id: 'record-1', name: 'Strategy', slug: 'strategy' };

/** Each kind's tables, and the names its link row uses for its record. */
const TABLES = {
  platform: { link: 'platformGatewayLink', record: 'platform', recordKey: 'platformId' },
  category: { link: 'categoryGatewayLink', record: 'category', recordKey: 'categoryId' },
  mechanic: { link: 'mechanicGatewayLink', record: 'mechanic', recordKey: 'mechanicId' },
} as const;

type MockTable = Record<'findUnique' | 'findMany' | 'count' | 'update', jest.Mock>;

describe.each(['platform', 'category', 'mechanic'] as const)('VocabularyLinkReviewService: %s links', (kind) => {
  let service: VocabularyLinkReviewService;
  let db: MockDatabaseService;
  let links: jest.Mocked<Pick<VocabularyLinkService, 'acceptPending'>>;

  const linkTable = (): MockTable => db[TABLES[kind].link] as unknown as MockTable;
  const recordTable = (): MockTable => db[TABLES[kind].record] as unknown as MockTable;

  beforeEach(async () => {
    links = { acceptPending: jest.fn() };

    const testing = await createTestingModuleWithDb({
      providers: [VocabularyLinkReviewService, { provide: VocabularyLinkService, useValue: links }],
    });

    db = testing.db;
    service = testing.module.get(VocabularyLinkReviewService);

    linkTable().findUnique.mockResolvedValue(storedLink(kind));
    linkTable().update.mockResolvedValue(storedLink(kind));
    recordTable().findUnique.mockResolvedValue({ id: RECORD.id });
  });

  afterEach(() => jest.clearAllMocks());

  it('lists the Pending links by default, by supplied name then id, from one snapshot', async () => {
    linkTable().findMany.mockResolvedValue([storedLink(kind)]);
    linkTable().count.mockResolvedValue(1);

    const page = await service.list(kind, GW, DEFAULT_VOCABULARY_REVIEW_STATUSES, { skip: 20, pageSize: 10 });

    const where = { gatewayId: GW, status: { in: [VocabularyLinkStatus.Pending] } };
    expect(linkTable().findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where, orderBy: [{ suppliedName: 'asc' }, { id: 'asc' }], skip: 20, take: 10 }),
    );
    expect(linkTable().count).toHaveBeenCalledWith({ where });
    expect(page).toEqual({ rows: [linkView(kind)], total: 1 });

    const { operations, options } = batchTransactionCall(db);
    expect(operations).toHaveLength(2);
    expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  });

  it('links a link to an existing record from any status, and refuses a record that does not exist', async () => {
    for (const status of Object.values(VocabularyLinkStatus)) {
      linkTable().findUnique.mockResolvedValueOnce(storedLink(kind, { status }));

      await expect(service.link(kind, GW, 'link-1', RECORD.id)).resolves.toEqual(linkView(kind));

      expect(linkTable().update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { id: 'link-1', gatewayId: GW },
          data: { status: VocabularyLinkStatus.Resolved, [TABLES[kind].recordKey]: RECORD.id },
        }),
      );
    }
    expect(recordTable().findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: RECORD.id } }));

    linkTable().update.mockClear();
    recordTable().findUnique.mockResolvedValue(null);

    const refusal = await service.link(kind, GW, 'link-1', 'record-missing').catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(BadRequestException);
    expect((refusal as BadRequestException).getResponse()).toEqual(
      t('errors.vocabulary_link.record_not_found', { recordId: 'record-missing' }),
    );
    expect(linkTable().update).not.toHaveBeenCalled();
  });

  it('ignores a link from any status, dropping its record', async () => {
    for (const status of Object.values(VocabularyLinkStatus)) {
      linkTable().findUnique.mockResolvedValueOnce(storedLink(kind, { status }));

      await service.ignore(kind, GW, 'link-1');

      expect(linkTable().update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { id: 'link-1', gatewayId: GW },
          data: { status: VocabularyLinkStatus.Ignored, [TABLES[kind].recordKey]: null },
        }),
      );
    }
  });

  it('accepts a Pending link, and answers 409 for one that is not', async () => {
    const accepted = storedLink(kind, { status: VocabularyLinkStatus.Resolved });
    linkTable()
      .findUnique.mockResolvedValueOnce(storedLink(kind, { status: VocabularyLinkStatus.Pending }))
      .mockResolvedValueOnce(accepted);
    links.acceptPending.mockResolvedValue({ accepted: true, recordId: RECORD.id });

    await expect(service.accept(kind, GW, 'link-1')).resolves.toEqual(
      linkView(kind, { status: VocabularyLinkStatus.Resolved }),
    );
    expect(links.acceptPending).toHaveBeenCalledWith(kind, 'link-1');

    links.acceptPending.mockResolvedValue({ accepted: false, reason: 'not_pending' });

    const refusal = await service.accept(kind, GW, 'link-1').catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as ConflictException).getResponse()).toEqual(
      t('errors.vocabulary_link.not_pending', { id: 'link-1' }),
    );
  });

  // A link id is unique across DataGateways, so a route scoped to one
  // DataGateway has to check the link is that DataGateway's own (#715).
  it.each([
    ['link', (s: VocabularyLinkReviewService) => s.link(kind, GW, 'link-of-gw-2', RECORD.id)],
    ['ignore', (s: VocabularyLinkReviewService) => s.ignore(kind, GW, 'link-of-gw-2')],
    ['accept', (s: VocabularyLinkReviewService) => s.accept(kind, GW, 'link-of-gw-2')],
  ] as const)('finds a link only under its own DataGateway, on %s', async (_action, call) => {
    linkTable().findUnique.mockResolvedValue(null);

    const refusal = await call(service).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(NotFoundException);
    expect((refusal as NotFoundException).getResponse()).toEqual(
      t('errors.vocabulary_link.not_found', { id: 'link-of-gw-2' }),
    );
    expect(linkTable().findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'link-of-gw-2', gatewayId: GW } }),
    );
    expect(linkTable().update).not.toHaveBeenCalled();
    expect(links.acceptPending).not.toHaveBeenCalled();
  });
});

/** A link row as Prisma reads it for `kind`: its record under the relation's name. */
function storedLink(kind: ReviewedVocabularyKind, overrides: { status?: VocabularyLinkStatus } = {}) {
  const common = {
    id: 'link-1',
    gatewayId: GW,
    externalId: '15',
    status: overrides.status ?? VocabularyLinkStatus.Pending,
    origin: VocabularyLinkOrigin.Interview,
    suppliedName: 'Strategy',
    createdAt: AT,
    updatedAt: AT,
  };

  switch (kind) {
    case 'platform':
      return { ...common, platform: RECORD, suppliedAbbreviation: 'STR', suppliedPlatformType: PlatformType.Other };
    case 'category':
      return { ...common, category: RECORD };
    case 'mechanic':
      return { ...common, mechanic: RECORD };
  }
}

/** The same link as the review routes return it. */
function linkView(kind: ReviewedVocabularyKind, overrides: Partial<VocabularyLinkView> = {}): VocabularyLinkView {
  const platform = kind === 'platform';

  return {
    id: 'link-1',
    gatewayId: GW,
    externalId: '15',
    status: VocabularyLinkStatus.Pending,
    origin: VocabularyLinkOrigin.Interview,
    record: RECORD,
    suppliedName: 'Strategy',
    suppliedAbbreviation: platform ? 'STR' : null,
    suppliedPlatformType: platform ? PlatformType.Other : null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}
