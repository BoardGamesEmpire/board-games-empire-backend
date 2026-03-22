import { PoliciesGuard } from '@bge/permissions';
import { createTestingModuleWithDb } from '@bge/testing';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { GameController } from './game.controller';
import { GameService } from './game.service';

describe('GameController', () => {
  let controller: GameController;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      providers: [GameService],
      controllers: [GameController],
      overrideGuards: [AuthGuard, PoliciesGuard],
    });

    controller = module.get(GameController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });
});
