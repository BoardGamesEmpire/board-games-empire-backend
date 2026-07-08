import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { JobStatus } from '@bge/database';
import { PoliciesGuard } from '@bge/permissions';
import { createTestingModuleWithDb } from '@bge/testing';
import { firstValueFrom, of } from 'rxjs';
import { ImportBatchStatus } from './interfaces/import-job.interface';
import { GameImportController } from './game-import.controller';
import { GameImportStatusService } from './services/import-status.service';

describe('GameImportController', () => {
  let controller: GameImportController;
  let importStatus: { getBatchStatus: jest.Mock; listBatchesForUser: jest.Mock };

  const batchStatus = {
    batchId: 'batch-1',
    correlationId: 'corr-1',
    status: ImportBatchStatus.Completed,
    jobs: [
      {
        jobId: 'job-1',
        status: JobStatus.Completed,
        isExpansion: false,
        externalId: 'ext-1',
        gameId: 'game-1',
        gameTitle: 'Catan',
        thumbnail: null,
        platformGames: [{ platformId: 'plat-1', platformGameId: 'pg-1' }],
        startedAt: null,
        completedAt: null,
      },
    ],
  };

  beforeEach(async () => {
    importStatus = {
      getBatchStatus: jest.fn().mockResolvedValue(batchStatus),
      listBatchesForUser: jest.fn().mockResolvedValue({ batches: [batchStatus] }),
    };

    const { module } = await createTestingModuleWithDb({
      controllers: [GameImportController],
      overrideGuards: [PoliciesGuard],
      providers: [
        {
          provide: GatewayCoordinatorClientService,
          useValue: {
            startGameImport: jest.fn().mockReturnValue(
              of({
                correlationId: 'test',
                batchId: 'batch-1',
                baseJobId: 'job-1',
                expansionJobIds: [],
              }),
            ),
          } satisfies Partial<jest.Mocked<GatewayCoordinatorClientService>>,
        },
        { provide: GameImportStatusService, useValue: importStatus },
      ],
    });

    controller = module.get(GameImportController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getImportStatus', () => {
    it('resolves the batch status through the status service', async () => {
      const response = await firstValueFrom(controller.getImportStatus('batch-1'));

      expect(importStatus.getBatchStatus).toHaveBeenCalledWith('batch-1');
      expect(response).toBe(batchStatus);
    });
  });

  describe('listImports', () => {
    it("lists the session user's batches with the given pagination", async () => {
      const session = { user: { id: 'user-7' } } as Parameters<GameImportController['listImports']>[0];
      const pagination = { offset: 0, limit: 5 };

      const response = await firstValueFrom(controller.listImports(session, pagination));

      expect(importStatus.listBatchesForUser).toHaveBeenCalledWith('user-7', pagination);
      expect(response).toEqual({ batches: [batchStatus] });
    });
  });
});
