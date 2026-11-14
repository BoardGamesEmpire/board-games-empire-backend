import { ResourceType } from '@bge/database';
import { ListScopeNotComposedError } from '@bge/shared';
import { paginationQuery } from '@bge/testing';
import { ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import { ListService } from './list.service';
import { UserListsController } from './user-lists.controller';

const PAGINATION = paginationQuery({ limit: 20 });

describe('UserListsController', () => {
  let controller: UserListsController;
  let service: jest.Mocked<Pick<ListService, 'listForUser'>>;

  beforeEach(() => {
    service = { listForUser: jest.fn().mockResolvedValue({ rows: [], total: 0 }) };
    controller = new UserListsController(service as never);
  });

  afterEach(() => jest.clearAllMocks());

  it('forwards the path user and the query, and wraps the page in the lists envelope (#1241)', async () => {
    const result = await firstValueFrom(controller.getUserLists('user-2', PAGINATION));

    expect(service.listForUser).toHaveBeenCalledWith('user-2', PAGINATION);
    expect(result).toEqual({
      lists: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasMore: false },
    });
  });

  it('builds its envelope under the List scope guard (#1241)', async () => {
    const envelope = ClsServiceManager.getClsService().runWith({}, () =>
      firstValueFrom(controller.getUserLists('user-2', PAGINATION)),
    );

    await expect(envelope).rejects.toThrow(ListScopeNotComposedError);
    await expect(envelope).rejects.toThrow(`intrinsic scope for '${ResourceType.List}'`);
  });
});
