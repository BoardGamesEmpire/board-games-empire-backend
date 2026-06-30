import {
  DriverNotRegisteredError,
  StorageMisconfiguredError,
  type StorageDriver,
  type StoredObject,
} from '@boardgamesempire/storage-contract';
import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { StorageService } from './storage.service.js';

function makeDriver(slug: string): jest.Mocked<StorageDriver> {
  const stored: StoredObject = {
    key: 'k',
    size: 1n,
    contentType: 'text/plain',
    checksum: 'abc',
    lastModified: new Date(0),
    driverSlug: slug,
  };
  return {
    slug,
    put: jest.fn().mockResolvedValue(stored),
    get: jest.fn().mockResolvedValue({ body: Readable.from(Buffer.from('x')), metadata: stored }),
    head: jest.fn().mockResolvedValue(stored),
    delete: jest.fn().mockResolvedValue(undefined),
    signedUrl: jest.fn().mockResolvedValue({ url: 'https://x', expiresAt: new Date(0), method: 'GET' }),
    list: jest.fn().mockResolvedValue({ objects: [] }),
  } as unknown as jest.Mocked<StorageDriver>;
}

describe('StorageService', () => {
  let localdisk: jest.Mocked<StorageDriver>;
  let s3: jest.Mocked<StorageDriver>;
  let service: StorageService;

  beforeEach(() => {
    localdisk = makeDriver('localdisk');
    s3 = makeDriver('s3');
    service = new StorageService([localdisk, s3], 'localdisk');
  });

  it('exposes the default-write slug', () => {
    expect(service.defaultWriteSlug).toBe('localdisk');
  });

  it('routes put to the default-write driver only', async () => {
    const body = Buffer.from('x');
    await service.put('k', body, { contentType: 'text/plain' });

    expect(localdisk.put).toHaveBeenCalledWith('k', body, expect.objectContaining({ contentType: 'text/plain' }));
    expect(s3.put).not.toHaveBeenCalled();
  });

  it('routes get to the driver named by the locator slug, not the write default', async () => {
    await service.get({ driverSlug: 's3', driverKey: 'obj' });

    expect(s3.get).toHaveBeenCalledWith('obj');
    expect(localdisk.get).not.toHaveBeenCalled();
  });

  it('routes head and delete by locator slug', async () => {
    await service.head({ driverSlug: 's3', driverKey: 'obj' });
    expect(s3.head).toHaveBeenCalledWith('obj');

    await service.delete({ driverSlug: 'localdisk', driverKey: 'obj' });
    expect(localdisk.delete).toHaveBeenCalledWith('obj');
    expect(s3.delete).not.toHaveBeenCalled();
  });

  it('routes signedUrl by locator slug and forwards op + options', async () => {
    await service.signedUrl({ driverSlug: 's3', driverKey: 'obj' }, 'get', {
      ttlSeconds: 60,
      contentType: 'image/png',
      bindings: { ownerId: 'u1' },
    });

    expect(s3.signedUrl).toHaveBeenCalledWith(
      'obj',
      'get',
      expect.objectContaining({ ttlSeconds: 60, bindings: { ownerId: 'u1' } }),
    );
    expect(localdisk.signedUrl).not.toHaveBeenCalled();
  });

  it('reads and deletes a pre-switch object on a non-write driver (the #100 regression)', async () => {
    // localdisk is the write default, but a legacy object still lives on s3.
    await service.get({ driverSlug: 's3', driverKey: 'legacy' });
    await service.delete({ driverSlug: 's3', driverKey: 'legacy' });

    expect(s3.get).toHaveBeenCalledWith('legacy');
    expect(s3.delete).toHaveBeenCalledWith('legacy');
    expect(localdisk.get).not.toHaveBeenCalled();
    expect(localdisk.delete).not.toHaveBeenCalled();
  });

  it('rejects an object-addressed op for an unregistered slug', async () => {
    await expect(service.get({ driverSlug: 'gcs', driverKey: 'obj' })).rejects.toBeInstanceOf(DriverNotRegisteredError);
    await expect(service.delete({ driverSlug: 'gcs', driverKey: 'obj' })).rejects.toBeInstanceOf(
      DriverNotRegisteredError,
    );
    expect(localdisk.get).not.toHaveBeenCalled();
    expect(s3.get).not.toHaveBeenCalled();
  });

  it('lists on the default-write driver', async () => {
    await service.list('prefix/', { cursor: 'c', limit: 10 });

    expect(localdisk.list).toHaveBeenCalledWith('prefix/', { cursor: 'c', limit: 10 });
    expect(s3.list).not.toHaveBeenCalled();
  });

  it('throws when the default-write slug is not registered', () => {
    expect(() => new StorageService([localdisk], 's3')).toThrow(StorageMisconfiguredError);
  });

  it('throws on a duplicate driver slug', () => {
    expect(() => new StorageService([localdisk, makeDriver('localdisk')], 'localdisk')).toThrow(
      StorageMisconfiguredError,
    );
  });
});
