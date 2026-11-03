import { Action } from '@bge/database';
import { CHECK_POLICIES_KEY, type AppAbility } from '@bge/permissions';
import { ListScopeNotComposedError } from '@bge/shared';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { ClsServiceManager } from 'nestjs-cls';
import 'reflect-metadata';
import { firstValueFrom } from 'rxjs';
import { AdminHouseholdListQueryDto } from './admin-household-list.query.dto';
import { AdminHouseholdController } from './admin-household.controller';
import type { AdminHouseholdService } from './admin-household.service';

const queryOf = (plain: Record<string, unknown> = {}) => plainToInstance(AdminHouseholdListQueryDto, plain);

describe('AdminHouseholdController (#419)', () => {
  let controller: AdminHouseholdController;
  let service: jest.Mocked<Pick<AdminHouseholdService, 'listHouseholds'>>;

  beforeEach(() => {
    service = { listHouseholds: jest.fn().mockResolvedValue({ rows: [], total: 0 }) };
    controller = new AdminHouseholdController(service as never);
  });

  afterEach(() => jest.clearAllMocks());

  // `read` on `all` is what staff and the Owner hold, and a user with only the
  // base role never does. A gate on `read Household` would let every user in,
  // to a list of their own households where the client counts on a 403.
  it('refuses anyone who cannot read every resource: it asks the guard for read on all', () => {
    const handlers = Reflect.getMetadata(
      CHECK_POLICIES_KEY,
      AdminHouseholdController.prototype.listHouseholds,
    ) as Array<(ability: AppAbility) => boolean>;
    const can = jest.fn().mockReturnValue(true);

    expect(handlers).toHaveLength(1);
    handlers[0]({ can } as unknown as AppAbility);
    expect(can).toHaveBeenCalledTimes(1);
    expect(can).toHaveBeenCalledWith(Action.read, 'all');
  });

  it('is mounted at GET admin/households, apart from the household routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminHouseholdController)).toBe('admin/households');
    expect(Reflect.getMetadata(METHOD_METADATA, AdminHouseholdController.prototype.listHouseholds)).toBe(
      RequestMethod.GET,
    );
  });

  it('forwards the query and wraps the page in the households envelope', async () => {
    const row = { id: 'hh-1' };
    service.listHouseholds.mockResolvedValue({ rows: [row], total: 31 } as never);
    const query = queryOf({ page: 2, limit: 10, status: 'all', q: 'catan', sort: 'deleted' });

    const response = await firstValueFrom(controller.listHouseholds(query));

    expect(service.listHouseholds).toHaveBeenCalledWith(query);
    expect(response).toEqual({
      households: [row],
      pagination: { page: 2, limit: 10, total: 31, totalPages: 4, hasMore: true },
    });
  });

  // The service composes the Household scope, and the envelope is where the
  // guard checks for it. Built inside a request with nothing composed, a
  // Household envelope fails. One declaring `Unscoped` would pass instead,
  // which switches the guard off for the route without a sound.
  it('builds its envelope under the Household scope guard', async () => {
    await expect(
      ClsServiceManager.getClsService().runWith({}, () => firstValueFrom(controller.listHouseholds(queryOf()))),
    ).rejects.toThrow(ListScopeNotComposedError);
  });
});
