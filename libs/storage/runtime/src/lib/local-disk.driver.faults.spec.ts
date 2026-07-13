import {
  InsufficientStorageError,
  ObjectNotFoundError,
  StorageMisconfiguredError,
  StorageUnavailableError,
} from '@boardgamesempire/storage-contract';
import type { ConfigService } from '@nestjs/config';
import { Buffer } from 'node:buffer';
import { statSync } from 'node:fs';
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
  statSync: jest.fn(() => ({ isDirectory: () => true, dev: 1 })),
}));

// Typed handles to the mocked bindings (evaluated at module-body time, post-import).
const mockMkdir = jest.mocked(mkdir);
const mockReadFile = jest.mocked(readFile);
const mockReaddir = jest.mocked(readdir);
const mockRm = jest.mocked(rm);
const mockStat = jest.mocked(stat);
const mockStatSync = jest.mocked(statSync);
const mockPipeline = jest.mocked(pipeline);

const ROOT = '/srv/media';
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
const dirStats = (dev: number): Stats => ({ isDirectory: () => true, dev }) as unknown as Stats;
/** A stat that never settles — simulates a hung syscall on an unreachable mount. */
const hang = (): Promise<Stats> => new Promise<Stats>(() => undefined);

function makeDriver(overrides: Partial<MediaConfig> = {}): LocalDiskDriver {
  const media: MediaConfig = {
    driver: 'localdisk',
    localDiskRoot: ROOT,
    signedUrlTtlSeconds: 300,
    baseUrl: 'https://bge.test',
    streamPath: '/media-stream',
    mountCheck: 'off',
    sentinelFile: '.bge-storage-sentinel',
    probeTimeoutMs: 5000,
    probeTimeoutFatalThreshold: 3,
    ...overrides,
  };
  const config = { getOrThrow: jest.fn().mockReturnValue(media) } as unknown as ConfigService;
  const signer = new MediaUrlSigner({ getSecret: jest.fn().mockResolvedValue('s') } as unknown as SigningKeyService);
  return new LocalDiskDriver(config, signer);
}

/** Test seam for the fatal watchdog — `exitProcess` is `protected`. */
const spyExit = (driver: LocalDiskDriver): jest.SpyInstance =>
  jest.spyOn(driver as unknown as { exitProcess: () => void }, 'exitProcess').mockImplementation(() => undefined);

describe('LocalDiskDriver error classification', () => {
  let driver: LocalDiskDriver;

  beforeEach(() => {
    jest.clearAllMocks();
    mockStatSync.mockReturnValue(dirStats(1)); // healthy root; off mode ignores dev
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

  it('maps an unmodeled root stat error to a generic unavailable (not "unmounted")', async () => {
    mockStat.mockRejectedValue(errno('ENOTDIR'));
    const err = await driver.ping().catch((e) => e);
    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect(err.message).toMatch(/Unexpected storage probe failure/);
    expect(err.message).not.toMatch(/unmounted/);
    expect(err.retryable).toBe(true);
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

describe('LocalDiskDriver mount check — st_dev', () => {
  const BASELINE = 10;
  let driver: LocalDiskDriver;

  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    mockStatSync.mockReturnValue(dirStats(BASELINE)); // baseline captured at construction
    driver = makeDriver({ mountCheck: 'st_dev' });
  });

  it('ping resolves when the device matches the baseline', async () => {
    mockStat.mockResolvedValue(dirStats(BASELINE));
    await expect(driver.ping()).resolves.toBeUndefined();
  });

  it('ping reports a retryable unavailable on device mismatch (unmounted volume)', async () => {
    mockStat.mockResolvedValue(dirStats(999));
    const err = await driver.ping().catch((e) => e);
    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect(err.retryable).toBe(true);
  });

  it('put refuses on device mismatch without creating the phantom directory', async () => {
    mockStat.mockResolvedValue(dirStats(999));
    await expect(driver.put('users/u/x', Buffer.from('x'), { contentType: 'text/plain' })).rejects.toBeInstanceOf(
      StorageUnavailableError,
    );
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockPipeline).not.toHaveBeenCalled();
  });

  it('put proceeds when the device matches', async () => {
    mockStat.mockResolvedValue({ dev: BASELINE, size: 3, mtime: new Date(0) } as unknown as Stats);
    mockPipeline.mockResolvedValue(undefined as never);
    const stored = await driver.put('users/u/x', Buffer.from('x'), { contentType: 'text/plain' });
    expect(mockMkdir).toHaveBeenCalled();
    expect(stored.key).toBe('users/u/x');
  });
});

describe('LocalDiskDriver mount check — auto', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('enables st_dev when the root is a distinct mount (dev differs from parent)', async () => {
    mockStatSync.mockImplementation((p) => (p === ROOT ? dirStats(10) : dirStats(20)));
    const driver = makeDriver({ mountCheck: 'auto' });
    mockStat.mockResolvedValue(dirStats(999)); // device drifted at runtime
    const err = await driver.ping().catch((e) => e);
    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect(err.retryable).toBe(true);
  });

  it('degrades to off when the root shares a filesystem with its parent', async () => {
    mockStatSync.mockReturnValue(dirStats(10)); // root.dev === parent.dev
    const driver = makeDriver({ mountCheck: 'auto' });
    mockStat.mockResolvedValue(dirStats(999)); // would mismatch, but the check is disabled
    await expect(driver.ping()).resolves.toBeUndefined();
  });

  it('degrades to off when the parent directory cannot be stat-ed', async () => {
    mockStatSync.mockImplementation((p) => {
      if (p === ROOT) return dirStats(10);
      throw errno('EACCES'); // parent (/srv) unreadable
    });
    const driver = makeDriver({ mountCheck: 'auto' });
    mockStat.mockResolvedValue(dirStats(999)); // would mismatch, but the check is disabled
    await expect(driver.ping()).resolves.toBeUndefined();
  });
});

describe('LocalDiskDriver mount check — sentinel', () => {
  const SENTINEL = `${ROOT}/.bge-storage-sentinel`;
  const rootOkSentinelGone = (p: unknown): Promise<Stats> =>
    p === ROOT ? Promise.resolve(dirStats(1)) : Promise.reject(errno('ENOENT'));

  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
  });

  it('throws StorageMisconfiguredError at boot when the sentinel is missing', () => {
    mockStatSync.mockImplementation((p) => {
      if (p === ROOT) return dirStats(1);
      throw errno('ENOENT'); // sentinel absent
    });
    expect(() => makeDriver({ mountCheck: 'sentinel' })).toThrow(StorageMisconfiguredError);
  });

  it('boot error names the exact touch command to run', () => {
    mockStatSync.mockImplementation((p) => {
      if (p === ROOT) return dirStats(1);
      throw errno('ENOENT');
    });
    expect(() => makeDriver({ mountCheck: 'sentinel' })).toThrow(`touch ${SENTINEL}`);
  });

  it.each(['', '.', '..', '../evil', '/etc/passwd', 'a/b', 'a\\b', 'sub/marker'])(
    'refuses to construct when the sentinel file is not a bare filename under the root (%p)',
    (bad) => {
      mockStatSync.mockReturnValue(dirStats(1));
      expect(() => makeDriver({ mountCheck: 'sentinel', sentinelFile: bad })).toThrow(StorageMisconfiguredError);
    },
  );

  it('boot distinguishes a permission failure from a missing sentinel (no touch hint)', () => {
    mockStatSync.mockImplementation((p) => {
      if (p === ROOT) return dirStats(1);
      throw errno('EACCES'); // sentinel present but unreadable
    });
    const err = (() => {
      try {
        makeDriver({ mountCheck: 'sentinel' });
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(StorageMisconfiguredError);
    expect(err?.message).not.toContain('touch');
    expect(err?.message).toMatch(/EACCES|permission/);
  });

  it('ping reports a retryable unavailable when the sentinel disappears at runtime', async () => {
    mockStatSync.mockReturnValue(dirStats(1)); // present at boot
    const driver = makeDriver({ mountCheck: 'sentinel' });
    mockStat.mockImplementation(rootOkSentinelGone);
    const err = await driver.ping().catch((e) => e);
    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect(err.retryable).toBe(true);
  });

  it('reports a non-retryable unavailable when the sentinel stat is denied (EACCES)', async () => {
    mockStatSync.mockReturnValue(dirStats(1)); // present at boot
    const driver = makeDriver({ mountCheck: 'sentinel' });
    mockStat.mockImplementation((p) => (p === ROOT ? Promise.resolve(dirStats(1)) : Promise.reject(errno('EACCES'))));
    const err = await driver.ping().catch((e) => e);
    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect(err.retryable).toBe(false); // permission error, not "unmounted"
  });

  it('put refuses when the sentinel is missing at runtime', async () => {
    mockStatSync.mockReturnValue(dirStats(1));
    const driver = makeDriver({ mountCheck: 'sentinel' });
    mockStat.mockImplementation(rootOkSentinelGone);
    await expect(driver.put('users/u/x', Buffer.from('x'), { contentType: 'text/plain' })).rejects.toBeInstanceOf(
      StorageUnavailableError,
    );
    expect(mockMkdir).not.toHaveBeenCalled();
  });

  it('bubbles an unmodeled sentinel stat error to the generic probe failure (not "missing")', async () => {
    mockStatSync.mockReturnValue(dirStats(1));
    const driver = makeDriver({ mountCheck: 'sentinel' });
    mockStat.mockImplementation((p) => (p === ROOT ? Promise.resolve(dirStats(1)) : Promise.reject(errno('ENOTDIR'))));
    const err = await driver.ping().catch((e) => e);
    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect(err.message).toMatch(/Unexpected storage probe failure/);
    expect(err.message).not.toMatch(/missing/);
  });

  it('ping resolves when the sentinel is present', async () => {
    mockStatSync.mockReturnValue(dirStats(1));
    const driver = makeDriver({ mountCheck: 'sentinel' });
    mockStat.mockResolvedValue(dirStats(1)); // root and sentinel both stat OK
    await expect(driver.ping()).resolves.toBeUndefined();
  });
});

describe('LocalDiskDriver probe timeout + fatal watchdog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStatSync.mockReturnValue(dirStats(1));
  });

  it('reports a retryable unavailable when a probe times out', async () => {
    const driver = makeDriver({ mountCheck: 'off', probeTimeoutMs: 25 });
    mockStat.mockImplementation(hang);
    const err = await driver.ping().catch((e) => e);
    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect(err.retryable).toBe(true);
  });

  it('self-exits after N consecutive probe timeouts', async () => {
    const driver = makeDriver({ mountCheck: 'off', probeTimeoutMs: 25, probeTimeoutFatalThreshold: 2 });
    const exit = spyExit(driver);
    mockStat.mockImplementation(hang);

    await driver.ping().catch(() => undefined); // timeout 1
    expect(exit).not.toHaveBeenCalled();
    await driver.ping().catch(() => undefined); // timeout 2 → fatal
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent probes into one in-flight stat and one timeout round', async () => {
    const driver = makeDriver({ mountCheck: 'off', probeTimeoutMs: 25, probeTimeoutFatalThreshold: 2 });
    const exit = spyExit(driver);
    mockStat.mockImplementation(hang);

    await Promise.all([driver.ping().catch(() => undefined), driver.ping().catch(() => undefined)]);
    expect(mockStat).toHaveBeenCalledTimes(1); // shared probe, not one stat per caller
    expect(exit).not.toHaveBeenCalled(); // a single consecutive timeout, threshold is 2

    await driver.ping().catch(() => undefined); // second serialized round → fatal
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('resets the consecutive-timeout counter after a successful probe', async () => {
    const driver = makeDriver({ mountCheck: 'off', probeTimeoutMs: 25, probeTimeoutFatalThreshold: 2 });
    const exit = spyExit(driver);

    mockStat.mockImplementationOnce(hang); // timeout (count 1)
    await driver.ping().catch(() => undefined);
    mockStat.mockResolvedValueOnce(dirStats(1)); // success → reset to 0
    await driver.ping();
    mockStat.mockImplementationOnce(hang); // timeout (count 1, not 2)
    await driver.ping().catch(() => undefined);

    expect(exit).not.toHaveBeenCalled();
  });
});
