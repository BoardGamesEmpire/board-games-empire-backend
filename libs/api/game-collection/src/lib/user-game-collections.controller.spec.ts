import { GameMedium, ResourceType } from '@bge/database';
import { ListScopeNotComposedError } from '@bge/shared';
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
  // envelope must fail. An `Unscoped` envelope would pass and switch the
  // guard off for the route.
  // The name is asserted too: an envelope naming another swept type would also
  // fail, for the wrong reason.
  it('builds its envelope under the GameCollection scope guard', async () => {
    const envelope = ClsServiceManager.getClsService().runWith({}, () =>
      firstValueFrom(controller.getUserCollection('user-2', PAGINATION)),
    );

    await expect(envelope).rejects.toThrow(ListScopeNotComposedError);
    await expect(envelope).rejects.toThrow(`intrinsic scope for '${ResourceType.GameCollection}'`);
  });
});
