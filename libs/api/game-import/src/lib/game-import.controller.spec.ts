import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { JobStatus, ResourceType } from '@bge/database';
import { AbilityService, PoliciesGuard } from '@bge/permissions';
import { ListScopeNotComposedError } from '@bge/shared';
import { createMockAbilityService, createTestingModuleWithDb, paginationQuery } from '@bge/testing';
import { ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom, of } from 'rxjs';
import { GameImportController } from './game-import.controller';
import { ImportBatchStatus } from './interfaces/import-job.interface';
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
      listBatchesForUser: jest.fn().mockResolvedValue({ rows: [batchStatus], total: 1 }),
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
        { provide: AbilityService, useValue: createMockAbilityService() },
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
    it("lists the acting user's batches with the given pagination", async () => {
      const pagination = paginationQuery({ limit: 5 });

      const response = await firstValueFrom(controller.listImports(pagination));

      expect(importStatus.listBatchesForUser).toHaveBeenCalledWith(pagination);
      expect(response).toEqual({
        batches: [batchStatus],
        pagination: { page: 1, limit: 5, total: 1, totalPages: 1, hasMore: false },
      });
    });

    // The service composes the `Job` scope; the envelope is where the guard
    // checks for it. Built inside a request with nothing composed, this
    // envelope must fail. An `Unscoped` envelope, or a type still in
    // `PENDING_SCOPE_SWEEP`, would pass and switch the guard off for the route.
    // The name is asserted too: an envelope naming another swept type would
    // also fail, for the wrong reason.
    it('builds its envelope under the Job scope guard', async () => {
      const envelope = ClsServiceManager.getClsService().runWith({}, () =>
        firstValueFrom(controller.listImports(paginationQuery({ limit: 5 }))),
      );

      await expect(envelope).rejects.toThrow(ListScopeNotComposedError);
      await expect(envelope).rejects.toThrow(`intrinsic scope for '${ResourceType.Job}'`);
    });

    // #372: the batches are the rows, so `total` is a batch count — the value a
    // client needs to say how far back the import history goes.
    it('echoes the requested page and the service total', async () => {
      importStatus.listBatchesForUser.mockResolvedValue({ rows: [batchStatus], total: 23 });

      const response = await firstValueFrom(controller.listImports(paginationQuery({ page: 3, limit: 5 })));

      expect(response).toEqual(
        expect.objectContaining({
          pagination: { page: 3, limit: 5, total: 23, totalPages: 5, hasMore: true },
        }),
      );
    });
  });
});
