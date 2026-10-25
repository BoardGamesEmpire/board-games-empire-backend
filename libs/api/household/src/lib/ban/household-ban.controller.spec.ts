import { paginationQuery } from '@bge/testing';
import 'reflect-metadata';
import { firstValueFrom } from 'rxjs';
import { HouseholdBanController } from './household-ban.controller';
import type { HouseholdBanView } from './household-ban.read-shape';
import type { HouseholdBanService } from './household-ban.service';

const BAN = { id: 'ban-1', householdId: 'hh-1', reason: null } as HouseholdBanView;

describe('HouseholdBanController (delegation)', () => {
  let controller: HouseholdBanController;
  let service: jest.Mocked<Pick<HouseholdBanService, 'ban' | 'list' | 'updateReason' | 'lift'>>;

  beforeEach(() => {
    service = {
      ban: jest.fn().mockResolvedValue(BAN),
      list: jest.fn().mockResolvedValue({ rows: [BAN], total: 1 }),
      updateReason: jest.fn().mockResolvedValue(BAN),
      lift: jest.fn().mockResolvedValue(BAN),
    };
    controller = new HouseholdBanController(service as never);
  });

  describe('each route answers in its envelope with its message (#782)', () => {
    it('ban forwards the household and the DTO, wrapping the ban with a success message', async () => {
      const dto = { userId: 'user-2', reason: 'Kept the good meeples' };

      const result = await firstValueFrom(controller.ban('hh-1', dto));

      expect(service.ban).toHaveBeenCalledWith('hh-1', dto);
      expect(result).toEqual({ message: expect.objectContaining({ key: 'success.household.ban_created' }), ban: BAN });
    });

    it('list forwards the household and the query, wrapping the page in the envelope', async () => {
      const query = paginationQuery({ limit: 10 });

      const result = await firstValueFrom(controller.list('hh-1', query));

      expect(service.list).toHaveBeenCalledWith('hh-1', query);
      expect(result).toEqual({
        bans: [BAN],
        pagination: { page: 1, limit: 10, total: 1, totalPages: 1, hasMore: false },
      });
    });

    it('updateReason forwards the household, the user and the DTO, wrapping the ban with a success message', async () => {
      const result = await firstValueFrom(controller.updateReason('hh-1', 'user-2', { reason: null }));

      expect(service.updateReason).toHaveBeenCalledWith('hh-1', 'user-2', { reason: null });
      expect(result).toEqual({ message: expect.objectContaining({ key: 'success.household.ban_updated' }), ban: BAN });
    });

    it('lift forwards the household and the user, wrapping the ban as it was with a success message', async () => {
      const result = await firstValueFrom(controller.lift('hh-1', 'user-2'));

      expect(service.lift).toHaveBeenCalledWith('hh-1', 'user-2');
      expect(result).toEqual({ message: expect.objectContaining({ key: 'success.household.ban_lifted' }), ban: BAN });
    });
  });
});
