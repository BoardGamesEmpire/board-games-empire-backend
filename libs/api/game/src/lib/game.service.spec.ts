import { Test } from '@nestjs/testing';
import { GameService } from './game.service';

describe('GameService', () => {
  let service: GameService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [GameService],
    }).compile();

    service = module.get(GameService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });
});
