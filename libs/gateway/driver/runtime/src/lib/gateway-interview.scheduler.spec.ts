import { Test } from '@nestjs/testing';
import { GatewayInterviewScheduler } from './gateway-interview.scheduler';
import { GatewayRegistryService } from './gateway-registry.service';

const HOUR = 60 * 60 * 1000;

describe('GatewayInterviewScheduler', () => {
  let scheduler: GatewayInterviewScheduler;
  let registry: { connectedGatewayIds: jest.Mock; refreshInterview: jest.Mock };

  beforeEach(async () => {
    registry = {
      connectedGatewayIds: jest.fn().mockReturnValue([]),
      refreshInterview: jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      providers: [GatewayInterviewScheduler, { provide: GatewayRegistryService, useValue: registry }],
    }).compile();

    scheduler = module.get(GatewayInterviewScheduler);
  });

  afterEach(() => {
    scheduler.onModuleDestroy();
    jest.useRealTimers();
  });

  it('checks every DataGateway its process has connected for a stale interview', async () => {
    registry.connectedGatewayIds.mockReturnValue(['bgg', 'igdb']);

    await scheduler.refresh();

    expect(registry.refreshInterview.mock.calls).toEqual([['bgg'], ['igdb']]);
  });

  it('checks each DataGateway on its own, so one that never answers holds up no other', async () => {
    registry.connectedGatewayIds.mockReturnValue(['hung', 'igdb']);
    registry.refreshInterview.mockImplementation((gatewayId: string) =>
      gatewayId === 'hung' ? new Promise<void>(() => undefined) : Promise.resolve(),
    );

    void scheduler.refresh();
    await Promise.resolve();

    expect(registry.refreshInterview).toHaveBeenCalledWith('igdb');
  });

  it('goes on to the next DataGateway when one check throws', async () => {
    registry.connectedGatewayIds.mockReturnValue(['broken', 'igdb']);
    registry.refreshInterview.mockRejectedValueOnce(new Error('gone'));

    await expect(scheduler.refresh()).resolves.toBeUndefined();

    expect(registry.refreshInterview).toHaveBeenCalledWith('igdb');
  });

  it('runs hourly from start-up until the module is destroyed', async () => {
    jest.useFakeTimers();
    registry.connectedGatewayIds.mockReturnValue(['bgg']);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(HOUR - 1);
    expect(registry.refreshInterview).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(registry.refreshInterview).toHaveBeenCalledTimes(1);

    scheduler.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(2 * HOUR);
    expect(registry.refreshInterview).toHaveBeenCalledTimes(1);
  });
});
