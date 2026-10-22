import { Action, ResourceType, VocabularyLinkStatus } from '@bge/database';
import { PoliciesGuard } from '@bge/permissions';
import { createTestingModuleWithDb, paginationQuery, shippedReadReaches } from '@bge/testing';
import { DEFAULT_VOCABULARY_REVIEW_STATUSES, VocabularyLinkReviewService } from '@bge/vocabulary';
import { NotFoundException, RequestMethod, type Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom, type Observable } from 'rxjs';
import {
  DataGatewayCategoryLinkController,
  DataGatewayMechanicLinkController,
  DataGatewayPlatformLinkController,
  type VocabularyLinkRoutes,
} from './data-gateway-vocabulary-link.controller';
import { DataGatewayService } from './data-gateway.service';
import type { VocabularyLinkQueryDto } from './dto';

const CONTROLLERS = {
  platform: DataGatewayPlatformLinkController,
  category: DataGatewayCategoryLinkController,
  mechanic: DataGatewayMechanicLinkController,
} as const;

describe.each(['platform', 'category', 'mechanic'] as const)('the %s link review routes (#718)', (kind) => {
  const Controller: Type<VocabularyLinkRoutes> = CONTROLLERS[kind];
  let controller: VocabularyLinkRoutes;
  let dataGateways: jest.Mocked<Pick<DataGatewayService, 'getById'>>;
  let review: jest.Mocked<Pick<VocabularyLinkReviewService, 'list' | 'link' | 'ignore' | 'accept'>>;

  const link = { id: 'link-1' };

  beforeEach(async () => {
    dataGateways = { getById: jest.fn().mockResolvedValue({ id: 'gw-1' }) };
    review = {
      list: jest.fn().mockResolvedValue({ rows: [link], total: 1 }),
      link: jest.fn().mockResolvedValue(link),
      ignore: jest.fn().mockResolvedValue(link),
      accept: jest.fn().mockResolvedValue(link),
    } as never;

    const { module } = await createTestingModuleWithDb({
      controllers: [Controller],
      providers: [
        { provide: DataGatewayService, useValue: dataGateways },
        { provide: VocabularyLinkReviewService, useValue: review },
      ],
      overrideGuards: [PoliciesGuard],
    });

    controller = module.get(Controller);
  });

  const query = (overrides: Partial<VocabularyLinkQueryDto> = {}) =>
    Object.assign(paginationQuery({ limit: 20 }), overrides) as VocabularyLinkQueryDto;

  it(`mounts the review routes under data-gateways/:id/${kind}-links`, () => {
    const route = (method: keyof VocabularyLinkRoutes) => {
      const handler = Controller.prototype[method];
      return [Reflect.getMetadata(METHOD_METADATA, handler), Reflect.getMetadata(PATH_METADATA, handler)];
    };

    expect(Reflect.getMetadata(PATH_METADATA, Controller)).toBe(`data-gateways/:id/${kind}-links`);
    expect(route('list')).toEqual([RequestMethod.GET, '/']);
    expect(route('link')).toEqual([RequestMethod.POST, ':linkId/link']);
    expect(route('ignore')).toEqual([RequestMethod.POST, ':linkId/ignore']);
    expect(route('accept')).toEqual([RequestMethod.POST, ':linkId/accept']);
  });

  it('is a controller of its own, so the three never share a route or an operation id', () => {
    expect(new Set(Object.values(CONTROLLERS).map((controllerType) => controllerType.name)).size).toBe(3);
  });

  // A key's scope can pin update to one DataGateway beside read on all, so
  // each route finds the DataGateway under its own action's conditions.
  it.each([
    ['list', (c: VocabularyLinkRoutes) => c.list('gw-1', query()), Action.read],
    ['link', (c: VocabularyLinkRoutes) => c.link('gw-1', 'link-1', { recordId: 'record-1' }), Action.update],
    ['ignore', (c: VocabularyLinkRoutes) => c.ignore('gw-1', 'link-1'), Action.update],
    ['accept', (c: VocabularyLinkRoutes) => c.accept('gw-1', 'link-1'), Action.update],
  ] as const)(
    'finds the DataGateway under the route’s own action before acting, on %s',
    async (_route, call, action) => {
      await firstValueFrom(call(controller) as Observable<unknown>);

      expect(dataGateways.getById.mock.calls).toEqual([['gw-1', action]]);
    },
  );

  // Links carry no foreign key to their DataGateway, so a deleted
  // DataGateway's links remain. Each route answers by the DataGateway's row.
  it.each([
    ['list', (c: VocabularyLinkRoutes) => c.list('gw-1', query())],
    ['link', (c: VocabularyLinkRoutes) => c.link('gw-1', 'link-1', { recordId: 'record-1' })],
    ['ignore', (c: VocabularyLinkRoutes) => c.ignore('gw-1', 'link-1')],
    ['accept', (c: VocabularyLinkRoutes) => c.accept('gw-1', 'link-1')],
  ] as const)('is a 404 from %s for a DataGateway that does not exist, and reviews nothing', async (_route, call) => {
    dataGateways.getById.mockRejectedValue(new NotFoundException());

    await expect(firstValueFrom(call(controller) as Observable<unknown>)).rejects.toThrow(NotFoundException);

    expect(review.list).not.toHaveBeenCalled();
    expect(review.link).not.toHaveBeenCalled();
    expect(review.ignore).not.toHaveBeenCalled();
    expect(review.accept).not.toHaveBeenCalled();
  });

  it('lists the Pending links when no status is asked for, and the statuses asked for otherwise', async () => {
    await expect(firstValueFrom(controller.list('gw-1', query()))).resolves.toEqual({
      [`${kind}Links`]: [link],
      pagination: expect.objectContaining({ total: 1 }),
    });
    expect(review.list).toHaveBeenCalledWith(
      kind,
      'gw-1',
      DEFAULT_VOCABULARY_REVIEW_STATUSES,
      expect.objectContaining({ pageSize: 20 }),
    );

    await firstValueFrom(controller.list('gw-1', query({ status: [VocabularyLinkStatus.Ignored] })));
    expect(review.list).toHaveBeenLastCalledWith(kind, 'gw-1', [VocabularyLinkStatus.Ignored], expect.anything());
  });

  // Built inside a request, where the envelope's scope guard is live.
  it('builds its envelope as unscoped, so the scope guard lets it through', async () => {
    await expect(
      ClsServiceManager.getClsService().runWith({}, () => firstValueFrom(controller.list('gw-1', query()))),
    ).resolves.toEqual(expect.objectContaining({ [`${kind}Links`]: [link] }));
  });

  // The Unscoped reason is a claim about the catalog, checked beside it.
  it('stays unscoped only while every role that reads DataGateways reads every row', () => {
    expect(new Set(shippedReadReaches(ResourceType.DataGateway))).toEqual(new Set(['every row']));
  });

  it('links, ignores and accepts through the review service, under the link’s own key', async () => {
    const envelope = { [`${kind}Link`]: link };

    await expect(firstValueFrom(controller.link('gw-1', 'link-1', { recordId: 'record-1' }))).resolves.toEqual(
      envelope,
    );
    await expect(firstValueFrom(controller.ignore('gw-1', 'link-1'))).resolves.toEqual(envelope);
    await expect(firstValueFrom(controller.accept('gw-1', 'link-1'))).resolves.toEqual(envelope);

    expect(review.link).toHaveBeenCalledWith(kind, 'gw-1', 'link-1', 'record-1');
    expect(review.ignore).toHaveBeenCalledWith(kind, 'gw-1', 'link-1');
    expect(review.accept).toHaveBeenCalledWith(kind, 'gw-1', 'link-1');
  });
});
