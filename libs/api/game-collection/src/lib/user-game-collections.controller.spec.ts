import { GameMedium, ResourceType } from '@bge/database';
import { ListScopeNotComposedError, NO_CACHE_KEY } from '@bge/shared';
import { paginationQuery } from '@bge/testing';
import { ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import { GameCollectionService } from './game-collection.service';
import { UserGameCollectionsController } from './user-game-collections.controller';

const PAGINATION = paginationQuery({ limit: 20 });

describe('UserGameCollectionsController', () => {
  let controller: UserGameCollectionsController;
  let service: jest.Mocked<Pick<GameCollectionService, 'listForUser'>>;

  beforeEach(() => {
    service = { listForUser: jest.fn().mockResolvedValue({ rows: [], total: 0 }) };
    controller = new UserGameCollectionsController(service as never);
  });

  afterEach(() => jest.clearAllMocks());

  it('forwards the path user and the query, and wraps the page in the envelope', async () => {
    const query = Object.assign(paginationQuery({ limit: 20 }), { medium: GameMedium.Digital });

    const result = await firstValueFrom(controller.getUserCollection('user-2', query));

    expect(service.listForUser).toHaveBeenCalledWith('user-2', query);
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
  it('builds its envelope under the GameCollection scope guard', async () => {
    const envelope = ClsServiceManager.getClsService().runWith({}, () =>
      firstValueFrom(controller.getUserCollection('user-2', PAGINATION)),
    );

    await expect(envelope).rejects.toThrow(ListScopeNotComposedError);
    await expect(envelope).rejects.toThrow(`intrinsic scope for '${ResourceType.GameCollection}'`);
  });

  // The route moved here from `GameCollectionController`, whose class-level
  // opt-out it used to inherit. Cached, a viewer unfriended within the TTL, or
  // an owner who has just made an entry Private, would be served the old page
  // (#530).
  it('is exempt from the response cache', () => {
    expect(Reflect.getMetadata(NO_CACHE_KEY, UserGameCollectionsController)).toBe(true);
  });
});
