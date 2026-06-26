import type { StorageDriver, StoredObject } from '@boardgamesempire/storage-contract';
import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { StorageService } from './storage.service.js';

describe('StorageService', () => {
  let driver: jest.Mocked<StorageDriver>;
  let service: StorageService;

  const sampleObject: StoredObject = {
    key: 'k',
    size: 1n,
    contentType: 'text/plain',
    checksum: 'abc',
    lastModified: new Date(0),
    driverSlug: 'localdisk',
  };

  beforeEach(() => {
    driver = {
      slug: 'localdisk',
      put: jest.fn(),
      get: jest.fn(),
      head: jest.fn(),
      delete: jest.fn(),
      signedUrl: jest.fn(),
      list: jest.fn(),
    } as unknown as jest.Mocked<StorageDriver>;

    driver.put.mockResolvedValue(sampleObject);
    driver.get.mockResolvedValue({ body: Readable.from(Buffer.from('x')), metadata: sampleObject });
    driver.head.mockResolvedValue(sampleObject);
    driver.delete.mockResolvedValue(undefined);
    driver.signedUrl.mockResolvedValue({ url: 'https://x', expiresAt: new Date(0), method: 'GET' });
    driver.list.mockResolvedValue({ objects: [] });

    service = new StorageService(driver);
  });

  it('exposes the active driver slug', () => {
    expect(service.driverSlug).toBe('localdisk');
  });

  it('forwards put to the driver', async () => {
    const stored = { key: 'k' } as StoredObject;
    driver.put.mockResolvedValue(stored);
    const body = Buffer.from('x');

    await expect(service.put('k', body, { contentType: 'text/plain' })).resolves.toBe(stored);
    expect(driver.put).toHaveBeenCalledWith('k', body, expect.objectContaining({ contentType: 'text/plain' }));
  });

  it('forwards signedUrl options to the driver', async () => {
    await service.signedUrl('k', 'get', { ttlSeconds: 60, contentType: 'image/png', bindings: { ownerId: 'u1' } });
    expect(driver.signedUrl).toHaveBeenCalledWith(
      'k',
      'get',
      expect.objectContaining({ ttlSeconds: 60, bindings: { ownerId: 'u1' } }),
    );
  });

  it('forwards delete and list', async () => {
    await service.delete('k');
    expect(driver.delete).toHaveBeenCalledWith('k');

    await service.list('prefix/', { cursor: 'cursor', limit: 10 });
    expect(driver.list).toHaveBeenCalledWith('prefix/', { cursor: 'cursor', limit: 10 });
  });
});
