import { firstValueFrom } from 'rxjs';
import { HouseholdController } from './household.controller';
import { HouseholdService } from './household.service';

const PAGINATION = { offset: 0, limit: 10 } as never;

describe('HouseholdController (no-Session delegation)', () => {
  let controller: HouseholdController;
  let service: jest.Mocked<
    Pick<
      HouseholdService,
      'getHouseholdsForUser' | 'getHouseholdById' | 'create' | 'updateHousehold' | 'deleteHousehold'
    >
  >;
  let cache: { del: jest.Mock };

  beforeEach(() => {
    service = {
      getHouseholdsForUser: jest.fn().mockResolvedValue([]),
      getHouseholdById: jest.fn().mockResolvedValue({ id: 'hh-1' }),
      create: jest.fn().mockResolvedValue({ id: 'hh-1', createdById: 'user-1' }),
      updateHousehold: jest.fn().mockResolvedValue({ id: 'hh-1' }),
      deleteHousehold: jest.fn().mockResolvedValue({ id: 'hh-1' }),
    };
    cache = { del: jest.fn() };
    controller = new HouseholdController(service as never, cache as never);
  });

  afterEach(() => jest.clearAllMocks());

  it('getHouseholdsForUser forwards only pagination', async () => {
    await firstValueFrom(controller.getHouseholdsForUser(PAGINATION));
    expect(service.getHouseholdsForUser).toHaveBeenCalledWith(PAGINATION);
  });

  it('create forwards only the dto (no Session) and invalidates the owner cache from the returned createdById', async () => {
    await firstValueFrom(controller.create({ name: 'Home' } as never));

    expect(service.create).toHaveBeenCalledWith({ name: 'Home' });
    expect(cache.del).toHaveBeenCalledWith('bge:user:permissions:user-1');
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
