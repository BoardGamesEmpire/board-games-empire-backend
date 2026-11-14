import { Action, ResourceType, WishlistPriority } from '@bge/database';
import { t } from '@bge/i18n';
import { CHECK_POLICIES_KEY, type AppAbility } from '@bge/permissions';
import { ListScopeNotComposedError } from '@bge/shared';
import { paginationQuery } from '@bge/testing';
import { ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import { ListEntryController } from './list-entry.controller';
import { ListEntryService } from './list-entry.service';

const PAGINATION = paginationQuery({ limit: 20 });
const LIST = 'list-1';

/** The routes' handlers, by method name, in declaration order. */
const handlers = () =>
  Object.getOwnPropertyNames(ListEntryController.prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => ({ name, handler: ListEntryController.prototype[name as keyof ListEntryController] as object }));

/** What each policy on `handler` asks of an ability that records the question. */
const askedBy = (handler: object) => {
  const policies = Reflect.getMetadata(CHECK_POLICIES_KEY, handler) as Array<(ability: AppAbility) => boolean>;
  const can = jest.fn().mockReturnValue(true);

  policies.forEach((policy) => policy({ can } as unknown as AppAbility));

  return can.mock.calls;
};

describe('ListEntryController (delegation)', () => {
  let controller: ListEntryController;
  let service: jest.Mocked<Pick<ListEntryService, 'list' | 'add' | 'update' | 'remove' | 'reorder'>>;

  beforeEach(() => {
    service = {
      list: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
      add: jest.fn().mockResolvedValue({ id: 'entry-1' }),
      update: jest.fn().mockResolvedValue({ id: 'entry-1' }),
      remove: jest.fn().mockResolvedValue(undefined),
      reorder: jest.fn().mockResolvedValue([{ id: 'entry-1' }]),
    };
    controller = new ListEntryController(service as never);
  });

  afterEach(() => jest.clearAllMocks());

  it('getEntries forwards the list id and query and wraps the page in the entries envelope (#1241)', async () => {
    const result = await firstValueFrom(controller.getEntries(LIST, PAGINATION));

    expect(service.list).toHaveBeenCalledWith(LIST, PAGINATION);
    expect(result).toEqual({
      entries: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasMore: false },
    });
  });

  // The service composes the parent list's `List` scope; the envelope is where
  // the guard checks for it. Built inside a request with nothing composed, it
  // must fail.
  it('getEntries builds its envelope under the List scope guard (#1241)', async () => {
    const envelope = ClsServiceManager.getClsService().runWith({}, () =>
      firstValueFrom(controller.getEntries(LIST, PAGINATION)),
    );

    await expect(envelope).rejects.toThrow(ListScopeNotComposedError);
    await expect(envelope).rejects.toThrow(`intrinsic scope for '${ResourceType.List}'`);
  });

  it('addEntry forwards the list id and dto and wraps the entry with a message (#1241)', async () => {
    const dto = { gameId: 'game-1', priority: WishlistPriority.MustHave };
    const result = await firstValueFrom(controller.addEntry(LIST, dto));

    expect(service.add).toHaveBeenCalledWith(LIST, dto);
    expect(result).toEqual({ entry: { id: 'entry-1' }, message: t('success.list.entry_added') });
  });

  it('updateEntry forwards the ids and dto and wraps the entry with a message (#1241)', async () => {
    const result = await firstValueFrom(controller.updateEntry(LIST, 'entry-1', { note: null }));

    expect(service.update).toHaveBeenCalledWith(LIST, 'entry-1', { note: null });
    expect(result).toEqual({ entry: { id: 'entry-1' }, message: t('success.list.entry_updated') });
  });

  it('removeEntry forwards the ids and answers with a message alone (#1241)', async () => {
    const result = await firstValueFrom(controller.removeEntry(LIST, 'entry-1'));

    expect(service.remove).toHaveBeenCalledWith(LIST, 'entry-1');
    expect(result).toEqual({ message: t('success.list.entry_removed') });
  });

  it('reorderEntries forwards the list id and dto and wraps the entries (#1241)', async () => {
    const dto = { entryIds: ['entry-1'] };
    const result = await firstValueFrom(controller.reorderEntries(LIST, dto));

    expect(service.reorder).toHaveBeenCalledWith(LIST, dto);
    expect(result).toEqual({ entries: [{ id: 'entry-1' }] });
  });

  // An entry is read with its list and written as part of it, so the routes
  // ask the list's own permissions (#1241).
  it('asks read on List to read the entries and update on List for every write (#1241)', () => {
    const asked = Object.fromEntries(handlers().map(({ name, handler }) => [name, askedBy(handler)]));

    expect(asked).toEqual({
      getEntries: [[Action.read, ResourceType.List]],
      reorderEntries: [[Action.update, ResourceType.List]],
      addEntry: [[Action.update, ResourceType.List]],
      updateEntry: [[Action.update, ResourceType.List]],
      removeEntry: [[Action.update, ResourceType.List]],
    });
  });

  // Nest matches routes in declaration order, so `order` must come before any
  // `:entryId` route that could take it for an id (#1241).
  it('declares the order route before every :entryId route (#1241)', () => {
    const routes = handlers().map(({ name, handler }) => ({
      name,
      path: Reflect.getMetadata('path', handler) as string,
    }));

    const order = routes.findIndex(({ path }) => path === 'order');
    const idRoutes = routes.flatMap(({ path }, index) => (path === ':entryId' ? [index] : []));

    expect(order).toBeGreaterThanOrEqual(0);
    expect(idRoutes.length).toBeGreaterThan(0);
    expect(idRoutes.every((index) => index > order)).toBe(true);
  });
});
