import { ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { ListScopeNotComposedError } from '@bge/shared';
import { paginationQuery } from '@bge/testing';
import { ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import { ListController } from './list.controller';
import { ListService } from './list.service';

const PAGINATION = paginationQuery({ limit: 20 });

describe('ListController (delegation)', () => {
  let controller: ListController;
  let service: jest.Mocked<Pick<ListService, 'listOwn' | 'getById' | 'create' | 'update' | 'remove' | 'reorder'>>;

  beforeEach(() => {
    service = {
      listOwn: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
      getById: jest.fn().mockResolvedValue({ id: 'list-1' }),
      create: jest.fn().mockResolvedValue({ id: 'list-1' }),
      update: jest.fn().mockResolvedValue({ id: 'list-1' }),
      remove: jest.fn().mockResolvedValue(undefined),
      reorder: jest.fn().mockResolvedValue([{ id: 'list-1' }]),
    };
    controller = new ListController(service as never);
  });

  afterEach(() => jest.clearAllMocks());

  it('getOwnLists forwards the query and wraps the page in the lists envelope (#1241)', async () => {
    const result = await firstValueFrom(controller.getOwnLists(PAGINATION));

    expect(service.listOwn).toHaveBeenCalledWith(PAGINATION);
    expect(result).toEqual({
      lists: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasMore: false },
    });
  });

  // The service composes the `List` scope; the envelope is where the guard
  // checks for it. Built inside a request with nothing composed, it must fail.
  it('getOwnLists builds its envelope under the List scope guard (#1241)', async () => {
    const envelope = ClsServiceManager.getClsService().runWith({}, () =>
      firstValueFrom(controller.getOwnLists(PAGINATION)),
    );

    await expect(envelope).rejects.toThrow(ListScopeNotComposedError);
    await expect(envelope).rejects.toThrow(`intrinsic scope for '${ResourceType.List}'`);
  });

  it('getList forwards the id and wraps the list (#1241)', async () => {
    const result = await firstValueFrom(controller.getList('list-1'));

    expect(service.getById).toHaveBeenCalledWith('list-1');
    expect(result).toEqual({ list: { id: 'list-1' } });
  });

  it('createList forwards the dto and wraps the list with a message (#1241)', async () => {
    const dto = { name: 'Top 100' };
    const result = await firstValueFrom(controller.createList(dto));

    expect(service.create).toHaveBeenCalledWith(dto);
    expect(result).toEqual({ list: { id: 'list-1' }, message: t('success.list.created') });
  });

  it('updateList forwards id and dto and wraps the list with a message (#1241)', async () => {
    const result = await firstValueFrom(controller.updateList('list-1', { name: 'x' }));

    expect(service.update).toHaveBeenCalledWith('list-1', { name: 'x' });
    expect(result).toEqual({ list: { id: 'list-1' }, message: t('success.list.updated') });
  });

  it('deleteList forwards the id and answers with a message alone (#1241)', async () => {
    const result = await firstValueFrom(controller.deleteList('list-1'));

    expect(service.remove).toHaveBeenCalledWith('list-1');
    expect(result).toEqual({ message: t('success.list.deleted') });
  });

  it('reorderLists forwards the dto and wraps the lists (#1241)', async () => {
    const dto = { listIds: ['list-1'] };
    const result = await firstValueFrom(controller.reorderLists(dto));

    expect(service.reorder).toHaveBeenCalledWith(dto);
    expect(result).toEqual({ lists: [{ id: 'list-1' }] });
  });

  // Nest matches routes in declaration order, so `PUT /lists/order` must come
  // before any `:id` route that could take "order" as an id (#1241).
  it('declares the order route before every :id route (#1241)', () => {
    const routes = Object.getOwnPropertyNames(ListController.prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => ({
        name,
        path: Reflect.getMetadata('path', ListController.prototype[name as keyof ListController]) as string,
      }));

    const order = routes.findIndex(({ path }) => path === 'order');
    const idRoutes = routes.flatMap(({ path }, index) => (path === ':id' ? [index] : []));

    expect(order).toBeGreaterThanOrEqual(0);
    expect(idRoutes.length).toBeGreaterThan(0);
    expect(idRoutes.every((index) => index > order)).toBe(true);
  });
});
