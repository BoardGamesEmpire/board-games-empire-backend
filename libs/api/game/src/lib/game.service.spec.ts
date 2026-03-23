import { createTestingModuleWithDb } from '@bge/testing';
import { GameService } from './game.service';

describe('GameService', () => {
  let service: GameService;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      providers: [GameService],
    });

    service = module.get(GameService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });
});
