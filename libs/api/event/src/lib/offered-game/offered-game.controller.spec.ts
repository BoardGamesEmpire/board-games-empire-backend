import { ResourceType } from '@bge/database';
import { PoliciesGuard } from '@bge/permissions';
import { createTestingModuleWithDb } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import { ListOfferedGamesQueryDto } from './dto/list-offered-games.query.dto';
import { OfferedGameController } from './offered-game.controller';
import { OfferedGameService } from './offered-game.service';
import type { OfferedGameRow } from './offered-game.types';

describe('OfferedGameController (#1187)', () => {
  let controller: OfferedGameController;
  let service: jest.Mocked<Pick<OfferedGameService, 'listOfferedGames'>>;

  beforeEach(async () => {
    service = { listOfferedGames: jest.fn() };

    const { module } = await createTestingModuleWithDb({
      controllers: [OfferedGameController],
      providers: [{ provide: OfferedGameService, useValue: service }],
      overrideGuards: [PoliciesGuard],
    });

    controller = module.get(OfferedGameController);
  });

  afterEach(() => jest.clearAllMocks());

  const query = (init: Record<string, unknown>) =>
    plainToInstance(ListOfferedGamesQueryDto, init, { enableImplicitConversion: true });

  it('wraps the rows in the offeredGames envelope', async () => {
    const rows = [{ id: 'gl-1' }, { id: 'gl-2' }] as OfferedGameRow[];
    service.listOfferedGames.mockResolvedValue({ rows, total: 5 });

    const listed = query({ limit: 2, q: 'catan' });
    const result = await firstValueFrom(controller.listOfferedGames('event-1', listed));

    expect(service.listOfferedGames).toHaveBeenCalledWith('event-1', listed);
    expect(result).toEqual({
      offeredGames: rows,
      pagination: { page: 1, limit: 2, total: 5, totalPages: 3, hasMore: true },
    });
  });

  // The service composes the offered-games scope; the envelope is where the
  // guard checks for it, under the type the handler names.
  it('builds its envelope under the EventAttendeeGameList scope guard', async () => {
    service.listOfferedGames.mockResolvedValue({ rows: [], total: 0 });

    const envelope = ClsServiceManager.getClsService().runWith({}, () =>
      firstValueFrom(controller.listOfferedGames('event-1', query({ limit: 10 }))),
    );

    await expect(envelope).rejects.toThrow(`intrinsic scope for '${ResourceType.EventAttendeeGameList}'`);
  });
});
