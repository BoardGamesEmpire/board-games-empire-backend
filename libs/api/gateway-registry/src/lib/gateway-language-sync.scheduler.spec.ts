import { Test } from '@nestjs/testing';
import { GatewayLanguageSyncScheduler } from './gateway-language-sync.scheduler';
import { GatewayLanguageSyncService } from './gateway-language-sync.service';
import { GatewayRegistryService } from './gateway-registry.service';

describe('GatewayLanguageSyncScheduler', () => {
  let scheduler: GatewayLanguageSyncScheduler;
  let registry: { connectedGatewayIds: jest.Mock; getServiceClient: jest.Mock };
  let languageSync: { syncIfStale: jest.Mock };

  beforeEach(async () => {
    registry = { connectedGatewayIds: jest.fn(), getServiceClient: jest.fn() };
    languageSync = { syncIfStale: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        GatewayLanguageSyncScheduler,
        { provide: GatewayRegistryService, useValue: registry },
        { provide: GatewayLanguageSyncService, useValue: languageSync },
      ],
    }).compile();

    scheduler = module.get(GatewayLanguageSyncScheduler);
  });

  afterEach(() => jest.clearAllMocks());

  it('runs syncIfStale for every connected gateway', async () => {
    const clientA = { listLanguages: jest.fn() };
    const clientB = { listLanguages: jest.fn() };
    registry.connectedGatewayIds.mockReturnValue(['gw-a', 'gw-b']);
    registry.getServiceClient.mockResolvedValueOnce(clientA).mockResolvedValueOnce(clientB);

    await scheduler.refresh();

    expect(languageSync.syncIfStale).toHaveBeenCalledWith('gw-a', clientA);
    expect(languageSync.syncIfStale).toHaveBeenCalledWith('gw-b', clientB);
  });

  it('continues past a gateway whose client cannot be resolved', async () => {
    registry.connectedGatewayIds.mockReturnValue(['gw-broken', 'gw-ok']);
    const client = { listLanguages: jest.fn() };
    registry.getServiceClient.mockRejectedValueOnce(new Error('gone')).mockResolvedValueOnce(client);

    await scheduler.refresh();

    expect(languageSync.syncIfStale).toHaveBeenCalledTimes(1);
    expect(languageSync.syncIfStale).toHaveBeenCalledWith('gw-ok', client);
  });

  it('does nothing when no gateways are connected', async () => {
    registry.connectedGatewayIds.mockReturnValue([]);

    await scheduler.refresh();

    expect(languageSync.syncIfStale).not.toHaveBeenCalled();
  });
});
