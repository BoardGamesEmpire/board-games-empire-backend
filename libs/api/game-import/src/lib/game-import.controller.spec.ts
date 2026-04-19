import { PoliciesGuard } from '@bge/permissions';
import { createTestingModuleWithDb } from '@bge/testing';
import { NotFoundException } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { firstValueFrom, of, throwError } from 'rxjs';
import type { ImportStartDto } from './dto/import-start.dto';
import { GameImportController } from './game-import.controller';
import { GameImportProducerService, type EnqueueResult } from './services/game-import-producer.service';

describe('GameImportController', () => {
  let controller: GameImportController;
  let producer: jest.Mocked<GameImportProducerService>;

  const mockProducer = {
    enqueue: jest.fn(),
  } satisfies Partial<jest.Mocked<GameImportProducerService>>;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      controllers: [GameImportController],
      overrideGuards: [PoliciesGuard],
      providers: [{ provide: GameImportProducerService, useValue: mockProducer }],
    });

    controller = module.get(GameImportController);
    producer = module.get(GameImportProducerService);
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('startImport()', () => {
    it('delegates to GameImportProducerService.enqueue with the DTO and user ID', async () => {
      const dto = makeDto();
      producer.enqueue.mockReturnValue(of(makeEnqueueResult()));

      await firstValueFrom(controller.startImport(makeSession('user-42'), dto));

      expect(producer.enqueue).toHaveBeenCalledWith(dto, 'user-42');
      expect(producer.enqueue).toHaveBeenCalledTimes(1);
    });

    it('returns batchId, baseJobId, expansionJobIds, correlationId, and message on success', async () => {
      const dto = makeDto({ correlationId: 'my-corr' });
      producer.enqueue.mockReturnValue(
        of(makeEnqueueResult({ batchId: 'b1', baseJobId: 'j1', expansionJobIds: ['e1', 'e2'] })),
      );

      const result = await firstValueFrom(controller.startImport(makeSession(), dto));

      expect(result).toEqual({
        message: 'Import enqueued',
        batchId: 'b1',
        baseJobId: 'j1',
        expansionJobIds: ['e1', 'e2'],
        correlationId: 'my-corr',
      });
    });

    it('returns an empty expansionJobIds array for base-game-only imports', async () => {
      producer.enqueue.mockReturnValue(of(makeEnqueueResult({ expansionJobIds: [] })));

      const result = await firstValueFrom(controller.startImport(makeSession(), makeDto()));

      expect(result.expansionJobIds).toEqual([]);
    });

    it('echoes the correlationId from the request DTO in the response', async () => {
      const dto = makeDto({ correlationId: 'custom-corr-id' });
      producer.enqueue.mockReturnValue(of(makeEnqueueResult()));

      const result = await firstValueFrom(controller.startImport(makeSession(), dto));

      expect(result.correlationId).toBe('custom-corr-id');
    });

    it('passes expansion external IDs through to the producer', async () => {
      const dto = makeDto({ expansionExternalIds: ['exp-1', 'exp-2'] });
      producer.enqueue.mockReturnValue(of(makeEnqueueResult()));

      await firstValueFrom(controller.startImport(makeSession(), dto));

      expect(producer.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ expansionExternalIds: ['exp-1', 'exp-2'] }),
        'user-1',
      );
    });

    it('propagates NotFoundException when the game is not found on the gateway', async () => {
      producer.enqueue.mockReturnValue(
        throwError(
          () => new NotFoundException('FetchGame returned no game data for gatewayId=igdb-gw-1 externalId=999'),
        ),
      );

      await expect(firstValueFrom(controller.startImport(makeSession(), makeDto()))).rejects.toThrow(NotFoundException);
    });

    it('propagates NotFoundException with the original message', async () => {
      const message = 'FetchGame returned no game data for gatewayId=igdb-gw-1 externalId=999';
      producer.enqueue.mockReturnValue(throwError(() => new NotFoundException(message)));

      await expect(firstValueFrom(controller.startImport(makeSession(), makeDto()))).rejects.toThrow(message);
    });

    it('propagates unexpected infrastructure errors', async () => {
      producer.enqueue.mockReturnValue(throwError(() => new Error('BullMQ connection refused')));

      await expect(firstValueFrom(controller.startImport(makeSession(), makeDto()))).rejects.toThrow(
        'BullMQ connection refused',
      );
    });

    it('passes different user IDs correctly', async () => {
      producer.enqueue.mockReturnValue(of(makeEnqueueResult()));

      await firstValueFrom(controller.startImport(makeSession('admin-99'), makeDto()));

      expect(producer.enqueue).toHaveBeenCalledWith(expect.anything(), 'admin-99');
    });

    it('passes different gatewayIds and externalIds through to the producer', async () => {
      const dto = makeDto({ gatewayId: 'bgg-gw-1', externalId: '66002' });
      producer.enqueue.mockReturnValue(of(makeEnqueueResult()));

      await firstValueFrom(controller.startImport(makeSession(), dto));

      expect(producer.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ gatewayId: 'bgg-gw-1', externalId: '66002' }),
        'user-1',
      );
    });
  });
});

function makeDto(overrides?: Partial<ImportStartDto>): ImportStartDto {
  return {
    correlationId: 'corr-import-1',
    gatewayId: 'igdb-gw-1',
    externalId: '174430',
    expansionExternalIds: [],
    ...overrides,
  };
}

function makeSession(userId = 'user-1'): UserSession {
  return {
    user: { id: userId },
    session: {},
  } as UserSession;
}

function makeEnqueueResult(overrides?: Partial<EnqueueResult>): EnqueueResult {
  return {
    batchId: 'batch-uuid-1',
    baseJobId: 'job-uuid-1',
    expansionJobIds: [],
    ...overrides,
  };
}
