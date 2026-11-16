import { ResourceType } from '@bge/database';
import { PoliciesGuard } from '@bge/permissions';
import { createTestingModuleWithDb } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import { ListLineupQueryDto } from './dto/list-lineup.query.dto';
import type { LineupGame } from './lineup-game';
import { LineupController } from './lineup.controller';
import { LineupService } from './lineup.service';

describe('LineupController (#799)', () => {
  let controller: LineupController;
  let service: jest.Mocked<Pick<LineupService, 'listLineup'>>;

  beforeEach(async () => {
    service = { listLineup: jest.fn() };

    const { module } = await createTestingModuleWithDb({
      controllers: [LineupController],
      providers: [{ provide: LineupService, useValue: service }],
      overrideGuards: [PoliciesGuard],
    });

    controller = module.get(LineupController);
  });

  afterEach(() => jest.clearAllMocks());

  const query = (init: Record<string, unknown>) =>
    plainToInstance(ListLineupQueryDto, init, { enableImplicitConversion: true });

  it('wraps the rows in the lineup envelope (#799)', async () => {
    const rows = [{ id: 'g1' }, { id: 'g2' }] as LineupGame[];
    service.listLineup.mockResolvedValue({ rows, total: 5 });

    const listed = query({ limit: 2, occurrenceId: 'occ-1' });
    const result = await firstValueFrom(controller.listLineup('event-1', listed));

    expect(service.listLineup).toHaveBeenCalledWith('event-1', listed);
    expect(result).toEqual({
      lineup: rows,
      pagination: { page: 1, limit: 2, total: 5, totalPages: 3, hasMore: true },
    });
  });

  // The service composes the lineup's scope; the envelope is where the guard
  // checks for it, under the type the handler names.
  it('builds its envelope under the EventGame scope guard (#799)', async () => {
    service.listLineup.mockResolvedValue({ rows: [], total: 0 });

    const envelope = ClsServiceManager.getClsService().runWith({}, () =>
      firstValueFrom(controller.listLineup('event-1', query({ limit: 10 }))),
    );

    await expect(envelope).rejects.toThrow(`intrinsic scope for '${ResourceType.EventGame}'`);
  });
});
