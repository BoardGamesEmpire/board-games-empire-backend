import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { PoliciesGuard } from '@bge/permissions';
import { createTestingModuleWithDb } from '@bge/testing';
import { of } from 'rxjs';
import { GameImportController } from './game-import.controller';

describe('GameImportController', () => {
  let controller: GameImportController;

  beforeEach(async () => {
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
      ],
    });

    controller = module.get(GameImportController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
