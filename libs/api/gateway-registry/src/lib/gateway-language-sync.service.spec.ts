import { LanguageCodeFormat } from '@bge/database';
import { LanguageLinkService } from '@bge/language';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import type { GatewayServiceClient } from '@boardgamesempire/proto-gateway';
import { of, throwError } from 'rxjs';
import { GatewayLanguageSyncService, LANGUAGE_SYNC_INTERVAL_MS } from './gateway-language-sync.service';

describe('GatewayLanguageSyncService', () => {
  let service: GatewayLanguageSyncService;
  let db: MockDatabaseService;
  let languageLinks: { interview: jest.Mock };

  const GW = 'gw-1';

  const clientWith = (languages: unknown[]): GatewayServiceClient =>
    ({
      listLanguages: jest.fn().mockReturnValue(of({ correlationId: 'c', languages })),
    }) as unknown as GatewayServiceClient;

  beforeEach(async () => {
    languageLinks = { interview: jest.fn().mockResolvedValue({ resolved: 0, pending: 0, unresolved: 0, ignored: 0 }) };

    const testing = await createTestingModuleWithDb({
      providers: [GatewayLanguageSyncService, { provide: LanguageLinkService, useValue: languageLinks }],
    });

    db = testing.db;
    service = testing.module.get(GatewayLanguageSyncService);
    db.gameGateway.update.mockResolvedValue({} as never);
  });

  afterEach(() => jest.clearAllMocks());

  it('interviews a gateway that has never been synced and stamps languagesSyncedAt', async () => {
    db.gameGateway.findUnique.mockResolvedValue({ languagesSyncedAt: null } as never);
    const client = clientWith([
      { value: 'en-US', format: 3, ietfTag: 'en-US', iso6393: 'eng', iso6391: 'en', name: 'English (US)' },
    ]);

    await service.syncIfStale(GW, client);

    expect(languageLinks.interview).toHaveBeenCalledWith(GW, [
      {
        value: 'en-US',
        format: LanguageCodeFormat.IetfBcp47,
        ietfTag: 'en-US',
        iso6393: 'eng',
        iso6391: 'en',
        name: 'English (US)',
        nativeName: undefined,
      },
    ]);
    expect(db.gameGateway.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { languagesSyncedAt: expect.any(Date) } }),
    );
  });

  it('maps string enum names (loader enums: String) to the Prisma format', async () => {
    db.gameGateway.findUnique.mockResolvedValue({ languagesSyncedAt: null } as never);
    const client = clientWith([
      { value: 'Czech', format: 'LANGUAGE_CODE_FORMAT_NAME', iso6393: 'ces', iso6391: 'cs', name: 'Czech' },
    ]);

    await service.syncIfStale(GW, client);

    expect(languageLinks.interview).toHaveBeenCalledWith(GW, [
      expect.objectContaining({ value: 'Czech', format: LanguageCodeFormat.Name }),
    ]);
  });

  it('skips the interview inside the throttle window', async () => {
    db.gameGateway.findUnique.mockResolvedValue({
      languagesSyncedAt: new Date(Date.now() - LANGUAGE_SYNC_INTERVAL_MS / 2),
    } as never);
    const client = clientWith([]);

    await service.syncIfStale(GW, client);

    expect(client.listLanguages).not.toHaveBeenCalled();
    expect(languageLinks.interview).not.toHaveBeenCalled();
  });

  it('re-interviews once the window has elapsed', async () => {
    db.gameGateway.findUnique.mockResolvedValue({
      languagesSyncedAt: new Date(Date.now() - LANGUAGE_SYNC_INTERVAL_MS - 1000),
    } as never);
    const client = clientWith([]);

    await service.syncIfStale(GW, client);

    expect(languageLinks.interview).toHaveBeenCalled();
  });

  it('drops entries with unknown formats or blank values', async () => {
    db.gameGateway.findUnique.mockResolvedValue({ languagesSyncedAt: null } as never);
    const client = clientWith([
      { value: '  ', format: 3 },
      { value: 'en', format: 0 },
      { value: 'en', format: 3 },
    ]);

    await service.syncIfStale(GW, client);

    expect(languageLinks.interview).toHaveBeenCalledWith(GW, [
      expect.objectContaining({ value: 'en', format: LanguageCodeFormat.IetfBcp47 }),
    ]);
  });

  it('never throws on RPC failure and still stamps the sync time (daily retry, not per-connect)', async () => {
    db.gameGateway.findUnique.mockResolvedValue({ languagesSyncedAt: null } as never);
    const client = {
      listLanguages: jest.fn().mockReturnValue(throwError(() => new Error('UNIMPLEMENTED'))),
    } as unknown as GatewayServiceClient;

    await expect(service.syncIfStale(GW, client)).resolves.toBeUndefined();
    expect(db.gameGateway.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { languagesSyncedAt: expect.any(Date) } }),
    );
  });
});
