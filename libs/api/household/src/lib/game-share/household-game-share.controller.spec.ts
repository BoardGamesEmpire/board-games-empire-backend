import type { GameShare } from '@bge/database';
import { paginationQuery } from '@bge/testing';
import 'reflect-metadata';
import { firstValueFrom } from 'rxjs';
import { HouseholdGameShareController } from './household-game-share.controller';
import type { HouseholdGameShareService, HouseholdGameShareView } from './household-game-share.service';

const LISTED = { id: 'share-1', approvedAt: null, game: { id: 'game-1' } } as HouseholdGameShareView;
const APPROVED = { id: 'share-1', approvedAt: new Date('2026-10-22T12:00:00Z') } as GameShare;

describe('HouseholdGameShareController (delegation)', () => {
  let controller: HouseholdGameShareController;
  let service: jest.Mocked<Pick<HouseholdGameShareService, 'listShares' | 'approve'>>;

  beforeEach(() => {
    service = {
      listShares: jest.fn().mockResolvedValue({ rows: [LISTED], total: 1 }),
      approve: jest.fn().mockResolvedValue(APPROVED),
    };
    controller = new HouseholdGameShareController(service as never);
  });

  it('listShares forwards the household and the query, wrapping the page in the envelope', async () => {
    const query = paginationQuery({ limit: 10 });

    const result = await firstValueFrom(controller.listShares('hh-1', query));

    expect(service.listShares).toHaveBeenCalledWith('hh-1', query);
    expect(result).toEqual({
      shares: [LISTED],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1, hasMore: false },
    });
  });

  it('approveShare forwards the household and the share, wrapping the share', async () => {
    const result = await firstValueFrom(controller.approveShare('hh-1', 'share-1'));

    expect(service.approve).toHaveBeenCalledWith('hh-1', 'share-1');
    expect(result).toEqual({ share: APPROVED });
  });
});
