import type { DatabaseService, SystemSetting } from '@bge/database';
import type { EncryptionService } from '@bge/services';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { StorageMisconfiguredError } from '@boardgamesempire/storage-contract';
import { SigningKeyService } from './signing-key.service.js';

const settings = (overrides: Partial<SystemSetting>): SystemSetting => overrides as unknown as SystemSetting;

describe('SigningKeyService', () => {
  let db: MockDatabaseService;
  let encryption: jest.Mocked<Pick<EncryptionService, 'decrypt' | 'encrypt'>>;
  let service: SigningKeyService;

  beforeEach(() => {
    db = createMockDatabaseService();
    encryption = { decrypt: jest.fn(), encrypt: jest.fn() };
    service = new SigningKeyService(db as unknown as DatabaseService, encryption as unknown as EncryptionService);
  });

  it('decrypts and returns the stored secret', async () => {
    db.systemSetting.findUnique.mockResolvedValue(settings({ mediaSigningSecret: 'iv:tag:ct' }));
    encryption.decrypt.mockReturnValue('plaintext-secret');

    await expect(service.getSecret()).resolves.toBe('plaintext-secret');
    expect(encryption.decrypt).toHaveBeenCalledWith('iv:tag:ct');
  });

  it('caches the secret after the first read', async () => {
    db.systemSetting.findUnique.mockResolvedValue(settings({ mediaSigningSecret: 'iv:tag:ct' }));
    encryption.decrypt.mockReturnValue('s');

    await service.getSecret();
    await service.getSecret();

    expect(db.systemSetting.findUnique).toHaveBeenCalledTimes(1);
  });

  it('re-reads after invalidate()', async () => {
    db.systemSetting.findUnique.mockResolvedValue(settings({ mediaSigningSecret: 'iv:tag:ct' }));
    encryption.decrypt.mockReturnValue('s');

    await service.getSecret();
    service.invalidate();
    await service.getSecret();

    expect(db.systemSetting.findUnique).toHaveBeenCalledTimes(2);
  });

  it('throws when no settings row exists', async () => {
    db.systemSetting.findUnique.mockResolvedValue(null);
    await expect(service.getSecret()).rejects.toBeInstanceOf(StorageMisconfiguredError);
  });

  it('throws when the secret is unset', async () => {
    db.systemSetting.findUnique.mockResolvedValue(settings({ mediaSigningSecret: null }));
    await expect(service.getSecret()).rejects.toBeInstanceOf(StorageMisconfiguredError);
  });
});
