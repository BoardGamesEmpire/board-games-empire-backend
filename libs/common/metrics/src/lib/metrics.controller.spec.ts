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

  it('is exempt from the global rate limiter', () => {
    // A throttled scrape endpoint returns 429 and leaves a gap in the series
    // that reads as an outage. `@SkipThrottle()` writes `THROTTLER:SKIP` + the
    // throttler name; the key is internal to @nestjs/throttler and spelled out
    // rather than imported, so a version that changes it fails here loudly.
    expect(Reflect.getMetadata('THROTTLER:SKIPdefault', MetricsController)).toBe(true);
  });
});
