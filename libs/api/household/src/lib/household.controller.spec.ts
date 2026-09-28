import { Action, ResourceType } from '@bge/database';
import { CHECK_POLICIES_KEY, type AppAbility } from '@bge/permissions';
import { ListScopeNotComposedError } from '@bge/shared';
import { paginationQuery } from '@bge/testing';
import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Http } from '@status/codes';
import { ClsServiceManager } from 'nestjs-cls';
import 'reflect-metadata';
import { firstValueFrom } from 'rxjs';
import { ALLOWS_DELETED_HOUSEHOLD_KEY } from './guards/household-liveness.guard';
import { HouseholdController } from './household.controller';
import { HouseholdService } from './household.service';

const PAGINATION = paginationQuery({ limit: 10 });

describe('HouseholdController (no-Session delegation)', () => {
  let controller: HouseholdController;
  let service: jest.Mocked<
    Pick<
      HouseholdService,
      | 'getHouseholdsForUser'
      | 'getHouseholdById'
      | 'create'
      | 'updateHousehold'
      | 'deleteHousehold'
      | 'restoreHousehold'
    >
  >;
  beforeEach(() => {
    service = {
      getHouseholdsForUser: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
      getHouseholdById: jest.fn().mockResolvedValue({ id: 'hh-1' }),
      create: jest.fn().mockResolvedValue({ id: 'hh-1', createdById: 'user-1' }),
      updateHousehold: jest.fn().mockResolvedValue({ id: 'hh-1' }),
      deleteHousehold: jest.fn().mockResolvedValue({ household: { id: 'hh-1' }, restorableUntil: null }),
      restoreHousehold: jest.fn().mockResolvedValue({ id: 'hh-1' }),
    };
    controller = new HouseholdController(service as never);
  });

  afterEach(() => jest.clearAllMocks());

  it('getHouseholdsForUser forwards only pagination', async () => {
    await firstValueFrom(controller.getHouseholdsForUser(PAGINATION));
    expect(service.getHouseholdsForUser).toHaveBeenCalledWith(PAGINATION);
  });

  // #230: the controller is where the rows the service read become the wire
  // envelope, so the echoed paging has to come from the query it was given.
  it('wraps the rows in the paginated envelope, echoing the requested page', async () => {
    service.getHouseholdsForUser.mockResolvedValue({ rows: [{ id: 'hh-1' }], total: 31 } as never);

    const response = await firstValueFrom(controller.getHouseholdsForUser(paginationQuery({ page: 2, limit: 10 })));

    expect(response).toEqual({
      households: [{ id: 'hh-1' }],
      pagination: { page: 2, limit: 10, total: 31, totalPages: 4, hasMore: true },
    });
  });

  // The service composes the `Household` scope; the envelope is where the
  // guard checks for it, under the resource type the handler passes. Built
  // inside a request with nothing composed, a `Household` envelope must fail.
  // A handler passing a type still in `PENDING_SCOPE_SWEEP` would pass here
  // instead, which switches the guard off for that route without a sound.
  it('getHouseholdsForUser builds its envelope under the Household scope guard', async () => {
    await expect(
      ClsServiceManager.getClsService().runWith({}, () => firstValueFrom(controller.getHouseholdsForUser(PAGINATION))),
    ).rejects.toThrow(ListScopeNotComposedError);
  });

  it('create forwards only the dto (no Session); cache invalidation is the service’s concern', async () => {
    await firstValueFrom(controller.create({ name: 'Home' } as never));

    expect(service.create).toHaveBeenCalledWith({ name: 'Home' });
  });

  it('create forwards clientRequestId untouched (idempotent replay is the service’s concern)', async () => {
    await firstValueFrom(controller.create({ name: 'Home', clientRequestId: 'key-1' } as never));

    expect(service.create).toHaveBeenCalledWith({ name: 'Home', clientRequestId: 'key-1' });
  });

  it('getById forwards only the id', async () => {
    await firstValueFrom(controller.getById('hh-1'));
    expect(service.getHouseholdById).toHaveBeenCalledWith('hh-1');
  });

  it('update forwards id and dto', async () => {
    await firstValueFrom(controller.update('hh-1', { name: 'New' } as never));
    expect(service.updateHousehold).toHaveBeenCalledWith('hh-1', { name: 'New' });
  });

  it('delete forwards only the id, and says until when it can be undone', async () => {
    const restorableUntil = new Date('2026-10-27T12:00:00Z');
    service.deleteHousehold.mockResolvedValue({ household: { id: 'hh-1' }, restorableUntil } as never);

    const response = await firstValueFrom(controller.delete('hh-1'));

    expect(service.deleteHousehold).toHaveBeenCalledWith('hh-1');
    expect(response).toEqual(expect.objectContaining({ household: { id: 'hh-1' }, restorableUntil }));
  });

  it('delete answers restorableUntil: null when no window was issued, rather than omitting it', async () => {
    // A staff or system delete. Present and null, so a client can tell "no
    // undo" from an older server that never sent the field.
    service.deleteHousehold.mockResolvedValue({ household: { id: 'hh-1' }, restorableUntil: null } as never);

    await expect(firstValueFrom(controller.delete('hh-1'))).resolves.toHaveProperty('restorableUntil', null);
  });

  describe('restore (#175)', () => {
    it('forwards only the id and wraps the household', async () => {
      const response = await firstValueFrom(controller.restore('hh-1'));

      expect(service.restoreHousehold).toHaveBeenCalledWith('hh-1');
      expect(response).toEqual(expect.objectContaining({ household: { id: 'hh-1' } }));
    });

    it('binds POST /households/:id/restore', () => {
      expect(Reflect.getMetadata('path', HouseholdController.prototype.restore)).toBe(':id/restore');
      expect(Reflect.getMetadata('method', HouseholdController.prototype.restore)).toBe(RequestMethod.POST);
    });

    it('answers 200: the household already exists, nothing is created', () => {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, HouseholdController.prototype.restore)).toBe(Http.Ok);
    });

    it('opts out of the liveness guard, since its target is a deleted household', () => {
      expect(Reflect.getMetadata(ALLOWS_DELETED_HOUSEHOLD_KEY, HouseholdController.prototype.restore)).toBe(true);
    });

    it('asks the guard for read, which every user holds, and leaves the decision to the service', () => {
      // An `update` check would 403 an ex-owner whose window has lapsed and
      // who holds no other household, while the same user with a second
      // household would reach the service and get 404: the split #299 removed.
      const handlers = Reflect.getMetadata(CHECK_POLICIES_KEY, HouseholdController.prototype.restore) as Array<
        (ability: AppAbility) => boolean
      >;
      const can = jest.fn().mockReturnValue(true);

      expect(handlers).toHaveLength(1);
      handlers[0]({ can } as unknown as AppAbility);

      expect(can).toHaveBeenCalledTimes(1);
      expect(can).toHaveBeenCalledWith(Action.read, ResourceType.Household);
    });
  });
});
