import { Test } from '@nestjs/testing';
import { MetricsController } from './metrics.controller';

describe('MetricsController', () => {
  let controller: MetricsController;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [],
      controllers: [MetricsController],
    }).compile();

    controller = module.get(MetricsController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });
});
