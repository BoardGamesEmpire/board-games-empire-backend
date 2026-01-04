import { Test } from '@nestjs/testing';
import { StrategyService } from './strategy.service';

describe('StrategyService', () => {
  let service: StrategyService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [StrategyService],
    }).compile();

    service = module.get(StrategyService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });
});
