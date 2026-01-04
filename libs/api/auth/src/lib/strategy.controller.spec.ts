import { Test } from '@nestjs/testing';
import { StrategyController } from './strategy.controller';
import { StrategyService } from './strategy.service';

describe('StrategyController', () => {
  let controller: StrategyController;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [StrategyService],
      controllers: [StrategyController],
    }).compile();

    controller = module.get(StrategyController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });
});
