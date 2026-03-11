import { Test } from '@nestjs/testing';
import { GameController } from './game.controller';
import { GameService } from './game.service';

describe('GameController', () => {
  let controller: GameController;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [GameService],
      controllers: [GameController],
    }).compile();

    controller = module.get(GameController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });
});
