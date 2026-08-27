import { paginationQuery } from '@bge/testing';
import { firstValueFrom } from 'rxjs';
import { HouseholdController } from './household.controller';
import { HouseholdService } from './household.service';

const PAGINATION = paginationQuery({ limit: 10 });

describe('HouseholdController (no-Session delegation)', () => {
  let controller: HouseholdController;
  let service: jest.Mocked<
    Pick<
      HouseholdService,
      | 'getHouseholdsForUser'
      | 'getHouseholdsForMember'
      | 'getHouseholdById'
      | 'create'
      | 'updateHousehold'
      | 'deleteHousehold'
    >
  >;
  beforeEach(() => {
    service = {
      getHouseholdsForUser: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
      getHouseholdsForMember: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
      getHouseholdById: jest.fn().mockResolvedValue({ id: 'hh-1' }),
      create: jest.fn().mockResolvedValue({ id: 'hh-1', createdById: 'user-1' }),
      updateHousehold: jest.fn().mockResolvedValue({ id: 'hh-1' }),
      deleteHousehold: jest.fn().mockResolvedValue({ id: 'hh-1' }),
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

  it('getHouseholdsForMember forwards only pagination', async () => {
    await firstValueFrom(controller.getHouseholdsForMember(PAGINATION));
    expect(service.getHouseholdsForMember).toHaveBeenCalledWith(PAGINATION);
  });

  it('wraps the membership-scoped rows in the same envelope as the wide list', async () => {
    service.getHouseholdsForMember.mockResolvedValue({ rows: [{ id: 'hh-1' }], total: 1 } as never);

    const response = await firstValueFrom(controller.getHouseholdsForMember(paginationQuery({ page: 1, limit: 10 })));

    expect(response).toEqual({
      households: [{ id: 'hh-1' }],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1, hasMore: false },
    });
  });

  // The two reads must not be crossed: `/households/mine` answering from the
  // role-widened query would hand an admin every household under a route whose
  // whole contract is that absence means "you were removed".
  it('keeps the two reads on separate service methods', async () => {
    await firstValueFrom(controller.getHouseholdsForMember(PAGINATION));
    expect(service.getHouseholdsForUser).not.toHaveBeenCalled();

    await firstValueFrom(controller.getHouseholdsForUser(PAGINATION));
    expect(service.getHouseholdsForMember).toHaveBeenCalledTimes(1);
  });

  /**
   * Nest matches routes in declaration order, so `@Get(':id')` declared above
   * `@Get('mine')` would capture `/households/mine` and answer 404 from the
   * detail route — the trap flagged in #364's roadmap. Class method order is
   * insertion order for string keys, so this asserts the actual mechanism
   * rather than a comment about it.
   */
  it('declares the membership route above the :id route, which is what keeps it reachable', () => {
    const declarationOrder = Object.getOwnPropertyNames(HouseholdController.prototype);

    expect(declarationOrder.indexOf('getHouseholdsForMember')).toBeGreaterThan(-1);
    expect(declarationOrder.indexOf('getHouseholdsForMember')).toBeLessThan(declarationOrder.indexOf('getById'));
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

  it('delete forwards only the id', async () => {
    await firstValueFrom(controller.delete('hh-1'));
    expect(service.deleteHousehold).toHaveBeenCalledWith('hh-1');
  });
});
