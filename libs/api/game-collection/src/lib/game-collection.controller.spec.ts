import { GameMedium, GameRemovalReason, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { ListScopeNotComposedError, NO_CACHE_KEY } from '@bge/shared';
import { paginationQuery } from '@bge/testing';
import { ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import { GameCollectionController } from './game-collection.controller';
import { GameCollectionService } from './game-collection.service';

const PAGINATION = paginationQuery({ limit: 20 });

describe('GameCollectionController (delegation)', () => {
  let controller: GameCollectionController;
  let service: jest.Mocked<
    Pick<GameCollectionService, 'listOwn' | 'getById' | 'addToCollection' | 'update' | 'remove'>
  >;

  beforeEach(() => {
    service = {
      listOwn: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
      getById: jest.fn().mockResolvedValue({ id: 'gc-1' }),
      addToCollection: jest.fn().mockResolvedValue({ id: 'gc-1' }),
      update: jest.fn().mockResolvedValue({ id: 'gc-1' }),
      remove: jest.fn().mockResolvedValue({ id: 'gc-1' }),
    };
    controller = new GameCollectionController(service as never);
  });

  afterEach(() => jest.clearAllMocks());

  it('getOwnCollection forwards the query and wraps the result in the envelope', async () => {
    const result = await firstValueFrom(controller.getOwnCollection(PAGINATION));
    expect(service.listOwn).toHaveBeenCalledWith(PAGINATION);
    expect(result).toEqual({
      collections: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasMore: false },
    });
  });

  // The service composes the `GameCollection` scope; the envelope is where the
  // guard checks for it. Built inside a request with nothing composed, this
  // envelope must fail. An `Unscoped` envelope, or a type still in
  // `PENDING_SCOPE_SWEEP`, would pass and switch the guard off for the route.
  // The name is asserted too: an envelope naming another swept type would also
  // fail, for the wrong reason.
  it('getOwnCollection builds its envelope under the GameCollection scope guard', async () => {
    const envelope = ClsServiceManager.getClsService().runWith({}, () =>
      firstValueFrom(controller.getOwnCollection(PAGINATION)),
    );

    await expect(envelope).rejects.toThrow(ListScopeNotComposedError);
    await expect(envelope).rejects.toThrow(`intrinsic scope for '${ResourceType.GameCollection}'`);
  });

  it('getCollectionEntry forwards the id', async () => {
    const result = await firstValueFrom(controller.getCollectionEntry('gc-1'));
    expect(service.getById).toHaveBeenCalledWith('gc-1');
    expect(result).toEqual({ collection: { id: 'gc-1' } });
  });

  it('addToCollection forwards the dto', async () => {
    const dto = { platformGameId: 'pg-1', medium: GameMedium.Physical };
    const result = await firstValueFrom(controller.addToCollection(dto));
    expect(service.addToCollection).toHaveBeenCalledWith(dto);
    expect(result).toMatchObject({ collection: { id: 'gc-1' }, message: t('success.game_collection.added') });
  });

  it('updateCollectionEntry forwards id and dto', async () => {
    await firstValueFrom(controller.updateCollectionEntry('gc-1', { quantity: 2 }));
    expect(service.update).toHaveBeenCalledWith('gc-1', { quantity: 2 });
  });

  it('removeFromCollection forwards id and reason query', async () => {
    await firstValueFrom(controller.removeFromCollection('gc-1', { reason: GameRemovalReason.Sold }));
    expect(service.remove).toHaveBeenCalledWith('gc-1', { reason: GameRemovalReason.Sold });
  });

  // The offline-first client writes and then re-reads to reconcile, so a read
  // served from the response cache within its TTL is a wrong answer.
  it('is exempt from the response cache', () => {
    expect(Reflect.getMetadata(NO_CACHE_KEY, GameCollectionController)).toBe(true);
  });
});
