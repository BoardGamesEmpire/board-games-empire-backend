import {
  InsufficientStorageError,
  ObjectNotFoundError,
  StorageUnavailableError,
} from '@boardgamesempire/storage-contract';
import type { ConfigService } from '@nestjs/config';
import { Buffer } from 'node:buffer';
import type { Stats } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { LocalDiskDriver } from './local-disk.driver.js';
import { MediaUrlSigner } from './media-url-signer.js';
import type { MediaConfig } from './media.config.js';
import type { SigningKeyService } from './signing-key.service.js';

// Factories return fresh objects and close over nothing — avoids the TDZ that
// bites when a hoisted jest.mock factory references an outer `const`.
jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(),
  readFile: jest.fn(),
  readdir: jest.fn(),
  rm: jest.fn(),
  stat: jest.fn(),
  writeFile: jest.fn(),
}));
jest.mock('node:stream/promises', () => ({ pipeline: jest.fn() }));
jest.mock('node:fs', () => ({
  createReadStream: jest.fn(),
  createWriteStream: jest.fn(() => ({})),
  statSync: jest.fn(() => ({ isDirectory: () => true })),
}));

// Typed handles to the mocked bindings (evaluated at module-body time, post-import).
const mockMkdir = jest.mocked(mkdir);
const mockReadFile = jest.mocked(readFile);
const mockReaddir = jest.mocked(readdir);
const mockRm = jest.mocked(rm);
const mockStat = jest.mocked(stat);
const mockPipeline = jest.mocked(pipeline);

const ROOT = '/srv/media';
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

function makeDriver(): LocalDiskDriver {
  const media: MediaConfig = {
    driver: 'localdisk',
    localDiskRoot: ROOT,
    signedUrlTtlSeconds: 300,
    baseUrl: 'https://bge.test',
    streamPath: '/media-stream',
  };
  const config = { getOrThrow: jest.fn().mockReturnValue(media) } as unknown as ConfigService;
  const signer = new MediaUrlSigner({ getSecret: jest.fn().mockResolvedValue('s') } as unknown as SigningKeyService);
  return new LocalDiskDriver(config, signer);
}

describe('LocalDiskDriver error classification', () => {
  let driver: LocalDiskDriver;

  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    driver = makeDriver();
  });

  it.each(['ENOSPC', 'EDQUOT'])('put maps %s to InsufficientStorageError', async (code) => {
    mockPipeline.mockRejectedValue(errno(code));
    await expect(driver.put('users/u/x', Buffer.from('x'), { contentType: 'text/plain' })).rejects.toBeInstanceOf(
      InsufficientStorageError,
    );
  });

  it('put cleans up partial bytes on failure', async () => {
    mockPipeline.mockRejectedValue(errno('EIO'));
    await expect(driver.put('users/u/x', Buffer.from('x'), { contentType: 'text/plain' })).rejects.toBeInstanceOf(
      StorageUnavailableError,
    );
    expect(mockRm).toHaveBeenCalled();
  });

  it('put rethrows an unmodeled errno raw (stays a 500)', async () => {
    mockPipeline.mockRejectedValue(errno('EMFILE'));
    await expect(driver.put('users/u/x', Buffer.from('x'), { contentType: 'text/plain' })).rejects.toMatchObject({
      code: 'EMFILE',
    });
  });

  it('head maps EIO to a retryable StorageUnavailableError', async () => {
    mockStat.mockRejectedValue(errno('EIO'));
    mockReadFile.mockRejectedValue(errno('EIO'));
    const err = await driver.head('users/u/x').catch((e) => e);
    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect(err.retryable).toBe(true);
  });

  it('head maps EACCES to a non-retryable StorageUnavailableError', async () => {
    mockStat.mockRejectedValue(errno('EACCES'));
    mockReadFile.mockRejectedValue(errno('EACCES'));
    const err = await driver.head('users/u/x').catch((e) => e);
    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect(err.retryable).toBe(false);
  });

  it('head treats object ENOENT as ObjectNotFound when the root is mounted', async () => {
    mockStat.mockImplementation((p) => (p === ROOT ? Promise.resolve({} as Stats) : Promise.reject(errno('ENOENT'))));
    mockReadFile.mockRejectedValue(errno('ENOENT'));
    await expect(driver.head('users/u/x')).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it('head maps ENOENT to a retryable StorageUnavailableError when the root is gone', async () => {
    mockStat.mockRejectedValue(errno('ENOENT')); // object path AND root
    mockReadFile.mockRejectedValue(errno('ENOENT'));
    const err = await driver.head('users/u/x').catch((e) => e);
    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect(err.retryable).toBe(true);
  });

  it('list maps EIO on the walk to StorageUnavailableError', async () => {
    mockReaddir.mockRejectedValue(errno('EIO'));
    await expect(driver.list('media/')).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('list returns empty for a missing subtree when the root is mounted', async () => {
    mockReaddir.mockRejectedValue(errno('ENOENT'));
    mockStat.mockResolvedValue({} as Stats);
    await expect(driver.list('media/')).resolves.toEqual({ objects: [], nextCursor: undefined });
  });

  it('ping resolves when the root is reachable', async () => {
    mockStat.mockResolvedValue({} as Stats);
    await expect(driver.ping()).resolves.toBeUndefined();
  });

  it('ping maps a missing root to a retryable StorageUnavailableError', async () => {
    mockStat.mockRejectedValue(errno('ENOENT'));
    const err = await driver.ping().catch((e) => e);
    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect(err.retryable).toBe(true);
  });

  it('ping maps EACCES on the root to a non-retryable StorageUnavailableError', async () => {
    mockStat.mockRejectedValue(errno('EACCES'));
    const err = await driver.ping().catch((e) => e);
    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect(err.retryable).toBe(false);
  });

  it('classifies EACCES on the root as a non-retryable unavailable (object read path)', async () => {
    mockStat.mockImplementation((p) =>
      p === ROOT ? Promise.reject(errno('EACCES')) : Promise.reject(errno('ENOENT')),
    );
    mockReadFile.mockRejectedValue(errno('ENOENT'));
    const err = await driver.head('users/u/x').catch((e) => e);
    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect(err.retryable).toBe(false);
  });
});
