import { LanguageCodeFormat, LanguageLinkOrigin, LanguageLinkStatus, Prisma } from '@bge/database';
import { t } from '@bge/i18n';
import { batchTransactionCall, createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  DEFAULT_REVIEW_STATUSES,
  LanguageLinkReviewService,
  type LanguageLinkView,
} from './language-link-review.service';
import { LanguageLinkService } from './language-link.service';

describe('LanguageLinkReviewService', () => {
  let service: LanguageLinkReviewService;
  let db: MockDatabaseService;
  let links: jest.Mocked<Pick<LanguageLinkService, 'acceptPending'>>;

  const GW = 'gw-1';

  beforeEach(async () => {
    links = { acceptPending: jest.fn() };

    const testing = await createTestingModuleWithDb({
      providers: [LanguageLinkReviewService, { provide: LanguageLinkService, useValue: links }],
    });

    db = testing.db;
    service = testing.module.get(LanguageLinkReviewService);

    db.languageGatewayLink.findUnique.mockResolvedValue(makeLink() as never);
    db.languageGatewayLink.update.mockResolvedValue(makeLink() as never);
    db.languageTag.findUnique.mockResolvedValue({ id: 'tag-en' } as never);
  });

  afterEach(() => jest.clearAllMocks());

  describe('list', () => {
    it("lists one DataGateway's links in the statuses asked for, by value, in one snapshot", async () => {
      const rows = [makeLink()];
      db.languageGatewayLink.findMany.mockResolvedValue(rows as never);
      db.languageGatewayLink.count.mockResolvedValue(1);

      const page = await service.list(GW, DEFAULT_REVIEW_STATUSES, { skip: 0, pageSize: 20 });

      const where = { gatewayId: GW, status: { in: [LanguageLinkStatus.Pending, LanguageLinkStatus.Unresolved] } };
      expect(db.languageGatewayLink.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where,
          orderBy: [{ value: 'asc' }, { id: 'asc' }],
          skip: 0,
          take: 20,
          select: expect.objectContaining({ tag: { select: { id: true, tag: true, name: true } } }),
        }),
      );
      expect(db.languageGatewayLink.count).toHaveBeenCalledWith({ where });
      expect(page).toEqual({ rows, total: 1 });

      const { operations, options } = batchTransactionCall(db);
      expect(operations).toHaveLength(2);
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    });
  });

  // A link id is unique across DataGateways, so a route scoped to one
  // DataGateway has to check the link is that DataGateway's own.
  describe('a link of another DataGateway', () => {
    it.each([
      ['link', (s: LanguageLinkReviewService) => s.link(GW, 'link-of-gw-2', 'tag-en')],
      ['ignore', (s: LanguageLinkReviewService) => s.ignore(GW, 'link-of-gw-2')],
      ['accept', (s: LanguageLinkReviewService) => s.accept(GW, 'link-of-gw-2')],
    ] as const)('is not found by %s, which writes nothing', async (_action, call) => {
      db.languageGatewayLink.findUnique.mockResolvedValue(null);

      const refusal = await call(service).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(NotFoundException);
      expect((refusal as NotFoundException).getResponse()).toEqual(
        t('errors.language_link.not_found', { id: 'link-of-gw-2' }),
      );
      expect(db.languageGatewayLink.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'link-of-gw-2', gatewayId: GW } }),
      );
      expect(db.languageGatewayLink.update).not.toHaveBeenCalled();
      expect(links.acceptPending).not.toHaveBeenCalled();
    });
  });

  describe('link', () => {
    it.each(Object.values(LanguageLinkStatus))('links a link that is %s to the tag', async (status) => {
      db.languageGatewayLink.findUnique.mockResolvedValue(makeLink({ status }) as never);

      await service.link(GW, 'link-1', 'tag-en');

      expect(db.languageGatewayLink.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'link-1', gatewayId: GW },
          data: { status: LanguageLinkStatus.Resolved, tagId: 'tag-en' },
        }),
      );
    });

    it('refuses a tag that does not exist with a 400', async () => {
      db.languageTag.findUnique.mockResolvedValue(null);

      const refusal = await service.link(GW, 'link-1', 'tag-missing').catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(BadRequestException);
      expect((refusal as BadRequestException).getResponse()).toEqual(
        t('errors.language_link.tag_not_found', { tagId: 'tag-missing' }),
      );
      expect(db.languageGatewayLink.update).not.toHaveBeenCalled();
    });
  });

  describe('ignore', () => {
    it.each(Object.values(LanguageLinkStatus))('ignores a link that is %s, dropping its tag', async (status) => {
      db.languageGatewayLink.findUnique.mockResolvedValue(makeLink({ status }) as never);

      await service.ignore(GW, 'link-1');

      expect(db.languageGatewayLink.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'link-1', gatewayId: GW },
          data: { status: LanguageLinkStatus.Ignored, tagId: null },
        }),
      );
    });
  });

  describe('accept', () => {
    it('answers with the link read again once accepted', async () => {
      const accepted = makeLink({
        status: LanguageLinkStatus.Resolved,
        tag: { id: 'tag-tlh', tag: 'tlh', name: 'Klingon' },
      });
      db.languageGatewayLink.findUnique
        .mockResolvedValueOnce(makeLink({ status: LanguageLinkStatus.Pending }) as never)
        .mockResolvedValueOnce(accepted as never);
      links.acceptPending.mockResolvedValue({ accepted: true, tagId: 'tag-tlh' });

      await expect(service.accept(GW, 'link-1')).resolves.toEqual(accepted);
      expect(links.acceptPending).toHaveBeenCalledWith('link-1');
    });

    it.each([
      ['not_pending', 'errors.language_link.not_pending'],
      ['not_acceptable', 'errors.language_link.not_acceptable'],
    ] as const)('answers %s with a 409', async (reason, key) => {
      links.acceptPending.mockResolvedValue({ accepted: false, reason });

      const refusal = await service.accept(GW, 'link-1').catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(ConflictException);
      expect((refusal as ConflictException).getResponse()).toEqual(t(key, { id: 'link-1' }));
    });
  });
});

function makeLink(overrides: Partial<LanguageLinkView> = {}): LanguageLinkView {
  return {
    id: 'link-1',
    gatewayId: 'gw-1',
    value: 'Klingon',
    format: LanguageCodeFormat.Name,
    status: LanguageLinkStatus.Unresolved,
    origin: LanguageLinkOrigin.Interview,
    tag: null,
    suppliedIetfTag: null,
    suppliedIso6393: null,
    suppliedIso6391: null,
    suppliedName: null,
    suppliedNativeName: null,
    createdAt: new Date('2026-10-01T12:00:00.000Z'),
    updatedAt: new Date('2026-10-01T12:00:00.000Z'),
    ...overrides,
  };
}
