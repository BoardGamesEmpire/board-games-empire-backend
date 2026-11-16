import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CHECK_POLICIES_KEY, PoliciesGuard, type AppAbility } from '@bge/permissions';
import { createTestingModuleWithDb } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { ClsServiceManager } from 'nestjs-cls';
import 'reflect-metadata';
import { firstValueFrom } from 'rxjs';
import { ListLineupQueryDto } from './dto/list-lineup.query.dto';
import type { LineupGame } from './lineup-game';
import { LineupController } from './lineup.controller';
import { LineupService } from './lineup.service';

describe('LineupController (#799)', () => {
  let controller: LineupController;
  let service: jest.Mocked<Pick<LineupService, 'listLineup' | 'removeLineupGame'>>;

  beforeEach(async () => {
    service = { listLineup: jest.fn(), removeLineupGame: jest.fn() };

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

  // The key is the glossary's word for it, not the older `eventGame` the
  // direct add still answers under.
  it('answers the removed game beside its message, as lineupGame (#769)', async () => {
    const lineupGame = { id: 'eg-1' } as LineupGame;
    service.removeLineupGame.mockResolvedValue(lineupGame);

    const result = await firstValueFrom(controller.removeLineupGame('event-1', 'eg-1'));

    expect(service.removeLineupGame).toHaveBeenCalledWith('event-1', 'eg-1');
    expect(result).toEqual({ message: t('success.lineup.removed'), lineupGame });
  });

  // The route judges the type alone; the service binds the check to the game.
  it('asks for delete on the lineup (#769)', () => {
    const handlers = Reflect.getMetadata(CHECK_POLICIES_KEY, LineupController.prototype.removeLineupGame) as Array<
      (ability: AppAbility) => boolean
    >;
    const can = jest.fn().mockReturnValue(true);

    expect(handlers).toHaveLength(1);
    handlers[0]({ can } as unknown as AppAbility);

    expect(can.mock.calls).toEqual([[Action.delete, ResourceType.EventGame]]);
  });
});
