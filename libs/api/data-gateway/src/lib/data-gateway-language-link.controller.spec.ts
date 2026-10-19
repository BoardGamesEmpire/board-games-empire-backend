import { Action, LanguageLinkStatus, ResourceType } from '@bge/database';
import { DEFAULT_REVIEW_STATUSES, LanguageLinkReviewService } from '@bge/language';
import { PoliciesGuard } from '@bge/permissions';
import { createTestingModuleWithDb, paginationQuery, shippedReadReaches } from '@bge/testing';
import { NotFoundException } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom, type Observable } from 'rxjs';
import { DataGatewayLanguageLinkController } from './data-gateway-language-link.controller';
import { DataGatewayService } from './data-gateway.service';
import type { LanguageLinkQueryDto } from './dto';

describe('DataGatewayLanguageLinkController', () => {
  let controller: DataGatewayLanguageLinkController;
  let dataGateways: jest.Mocked<Pick<DataGatewayService, 'getById'>>;
  let review: jest.Mocked<Pick<LanguageLinkReviewService, 'list' | 'link' | 'ignore' | 'accept'>>;

  const link = { id: 'link-1' };

  beforeEach(async () => {
    dataGateways = { getById: jest.fn().mockResolvedValue({ id: 'gw-1' }) };
    review = {
      list: jest.fn().mockResolvedValue({ rows: [link], total: 1 }),
      link: jest.fn().mockResolvedValue(link),
      ignore: jest.fn().mockResolvedValue(link),
      accept: jest.fn().mockResolvedValue(link),
    };

    const { module } = await createTestingModuleWithDb({
      controllers: [DataGatewayLanguageLinkController],
      providers: [
        { provide: DataGatewayService, useValue: dataGateways },
        { provide: LanguageLinkReviewService, useValue: review },
      ],
      overrideGuards: [PoliciesGuard],
    });

    controller = module.get(DataGatewayLanguageLinkController);
  });

  const query = (overrides: Partial<LanguageLinkQueryDto> = {}) =>
    Object.assign(paginationQuery({ limit: 20 }), overrides) as LanguageLinkQueryDto;

  // Links carry no foreign key to their DataGateway, so a deleted
  // DataGateway's links remain. Each route answers by the DataGateway's row.
  describe('a DataGateway that does not exist, or was deleted', () => {
    it.each([
      ['list', (c: DataGatewayLanguageLinkController) => c.list('gw-1', query())],
      ['link', (c: DataGatewayLanguageLinkController) => c.link('gw-1', 'link-1', { tagId: 'tag-en' })],
      ['ignore', (c: DataGatewayLanguageLinkController) => c.ignore('gw-1', 'link-1')],
      ['accept', (c: DataGatewayLanguageLinkController) => c.accept('gw-1', 'link-1')],
    ] as const)('is a 404 from %s, which reviews nothing', async (_action, call) => {
      dataGateways.getById.mockRejectedValue(new NotFoundException());

      await expect(firstValueFrom(call(controller) as Observable<unknown>)).rejects.toThrow(NotFoundException);

      expect(dataGateways.getById).toHaveBeenCalledWith('gw-1', expect.anything());
      expect(review.list).not.toHaveBeenCalled();
      expect(review.link).not.toHaveBeenCalled();
      expect(review.ignore).not.toHaveBeenCalled();
      expect(review.accept).not.toHaveBeenCalled();
    });

    // A key's scope can pin update to one DataGateway beside read on all, so
    // each route finds the DataGateway under its own action's conditions.
    it.each([
      ['list', (c: DataGatewayLanguageLinkController) => c.list('gw-1', query()), Action.read],
      ['link', (c: DataGatewayLanguageLinkController) => c.link('gw-1', 'link-1', { tagId: 'tag-en' }), Action.update],
      ['ignore', (c: DataGatewayLanguageLinkController) => c.ignore('gw-1', 'link-1'), Action.update],
      ['accept', (c: DataGatewayLanguageLinkController) => c.accept('gw-1', 'link-1'), Action.update],
    ] as const)("is looked up under %s's own action", async (_route, call, action) => {
      await firstValueFrom(call(controller) as Observable<unknown>);

      expect(dataGateways.getById.mock.calls).toEqual([['gw-1', action]]);
    });
  });

  describe('list', () => {
    it('lists Pending and Unresolved links when no status is asked for', async () => {
      const response = await firstValueFrom(controller.list('gw-1', query()));

      expect(review.list).toHaveBeenCalledWith(
        'gw-1',
        DEFAULT_REVIEW_STATUSES,
        expect.objectContaining({ pageSize: 20 }),
      );
      expect(response).toEqual({ languageLinks: [link], pagination: expect.objectContaining({ total: 1 }) });
    });

    it('lists the statuses asked for', async () => {
      await firstValueFrom(controller.list('gw-1', query({ status: [LanguageLinkStatus.Ignored] })));

      expect(review.list).toHaveBeenCalledWith('gw-1', [LanguageLinkStatus.Ignored], expect.anything());
    });

    // Built inside a request, where the envelope's scope guard is live.
    it('builds its envelope as unscoped, so the scope guard lets it through', async () => {
      await expect(
        ClsServiceManager.getClsService().runWith({}, () => firstValueFrom(controller.list('gw-1', query()))),
      ).resolves.toEqual(expect.objectContaining({ languageLinks: [link] }));
    });

    // The Unscoped reason is a claim about the catalog, checked beside it: a
    // conditioned read on DataGateway granted later fails here.
    it('stays unscoped only while every role that reads DataGateways reads every row', () => {
      expect(new Set(shippedReadReaches(ResourceType.DataGateway))).toEqual(new Set(['every row']));
    });
  });

  describe('actions', () => {
    it('links through the review service', async () => {
      await expect(firstValueFrom(controller.link('gw-1', 'link-1', { tagId: 'tag-en' }))).resolves.toEqual({
        languageLink: link,
      });
      expect(review.link).toHaveBeenCalledWith('gw-1', 'link-1', 'tag-en');
    });

    it('ignores through the review service', async () => {
      await expect(firstValueFrom(controller.ignore('gw-1', 'link-1'))).resolves.toEqual({ languageLink: link });
      expect(review.ignore).toHaveBeenCalledWith('gw-1', 'link-1');
    });

    it('accepts through the review service', async () => {
      await expect(firstValueFrom(controller.accept('gw-1', 'link-1'))).resolves.toEqual({ languageLink: link });
      expect(review.accept).toHaveBeenCalledWith('gw-1', 'link-1');
    });
  });
});
