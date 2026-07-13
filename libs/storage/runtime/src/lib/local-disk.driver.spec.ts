import { InvalidObjectKeyError, StorageMisconfiguredError } from '@boardgamesempire/storage-contract';
import { runStorageDriverContract } from '@boardgamesempire/storage-contract-testing';
import type { ConfigService } from '@nestjs/config';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDiskDriver } from './local-disk.driver.js';
import { MediaUrlSigner } from './media-url-signer.js';
import type { MediaConfig } from './media.config.js';
import type { SigningKeyService } from './signing-key.service.js';

function makeConfig(root: string): ConfigService {
  const media: MediaConfig = {
    driver: 'localdisk',
    localDiskRoot: root,
    signedUrlTtlSeconds: 300,
    baseUrl: 'https://bge.test',
    streamPath: '/media-stream',
    // Off keeps these general-behavior/contract tests identical to pre-mount-check
    // behavior; the mount-check strategies have dedicated coverage in the faults spec.
    mountCheck: 'off',
    sentinelFile: '.bge-storage-sentinel',
    probeTimeoutMs: 5000,
    probeTimeoutFatalThreshold: 3,
  };
  return { getOrThrow: jest.fn().mockReturnValue(media) } as unknown as ConfigService;
}

const signer = new MediaUrlSigner({ getSecret: jest.fn().mockResolvedValue('secret') } as unknown as SigningKeyService);

describe('LocalDiskDriver', () => {
  // Behavioral contract: a fresh temp root per test.
  runStorageDriverContract(async () => {
    const root = await mkdtemp(join(tmpdir(), 'bge-localdisk-'));
    return {
      driver: new LocalDiskDriver(makeConfig(root), signer),
      teardown: () => rm(root, { recursive: true, force: true }),
    };
  });

  describe('LocalDisk specifics', () => {
    let root: string;
    let driver: LocalDiskDriver;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'bge-localdisk-'));
      driver = new LocalDiskDriver(makeConfig(root), signer);
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('refuses to sign a non-canonical key', async () => {
      await expect(driver.signedUrl('a/../escape.txt', 'get', { ttlSeconds: 300 })).rejects.toBeInstanceOf(
        InvalidObjectKeyError,
      );
    });

    it.each([Infinity, NaN, 0, -5])('refuses to sign with a non-positive/non-finite ttl %p', async (ttl) => {
      await driver.put('media/a.png', Buffer.from('x'), { contentType: 'image/png' });
      await expect(driver.signedUrl('media/a.png', 'get', { ttlSeconds: ttl })).rejects.toBeInstanceOf(RangeError);
    });

    it('accepts a dot-dot-prefixed segment that is not a traversal', async () => {
      const stored = await driver.put('..thumbnails/cat.jpg', Buffer.from('x'), { contentType: 'image/jpeg' });
      expect(stored.key).toBe('..thumbnails/cat.jpg');
      await expect(driver.head('..thumbnails/cat.jpg')).resolves.toMatchObject({ key: '..thumbnails/cat.jpg' });
    });

    it.each(['a/..', '..', 'a/../b', 'a//b', 'a\\b'])('rejects a non-canonical list prefix %p', async (prefix) => {
      await expect(driver.list(prefix)).rejects.toBeInstanceOf(InvalidObjectKeyError);
    });

    it('accepts an empty prefix (list all) and a trailing-slash prefix', async () => {
      await driver.put('media/a.png', Buffer.from('x'), { contentType: 'image/png' });
      await expect(driver.list('')).resolves.toMatchObject({ objects: expect.any(Array) });
      await expect(driver.list('media/')).resolves.toMatchObject({ objects: expect.any(Array) });
    });

    it('mints a signed GET URL the signer accepts, with no owner/mime in the query', async () => {
      await driver.put('media/a.png', Buffer.from('x'), { contentType: 'image/png' });
      const signed = await driver.signedUrl('media/a.png', 'get', {
        ttlSeconds: 300,
        contentType: 'image/png',
        bindings: { ownerId: 'u1' },
      });

      expect(signed.url).toContain('https://bge.test/media-stream?');
      const url = new URL(signed.url);
      expect(url.searchParams.get('slug')).toBe('localdisk');
      expect(url.searchParams.get('op')).toBe('get');
      expect(url.searchParams.get('ct')).toBeNull();
      expect(url.searchParams.get('ownerId')).toBeNull();

      const exp = Number(url.searchParams.get('exp'));
      await expect(
        signer.verify(
          {
            slug: 'localdisk',
            key: 'media/a.png',
            op: 'get',
            expiresAt: exp,
            contentType: 'image/png',
            bindings: { ownerId: 'u1' },
          },
          url.searchParams.get('sig') ?? '',
        ),
      ).resolves.toBeUndefined();
    });

    it('rejects path-traversal keys', async () => {
      await expect(driver.put('../escape.txt', Buffer.from('x'), { contentType: 'text/plain' })).rejects.toBeInstanceOf(
        InvalidObjectKeyError,
      );
    });

    it('persists content type via the sidecar', async () => {
      await driver.put('media/b.json', Buffer.from('{}'), { contentType: 'application/json' });
      const head = await driver.head('media/b.json');
      expect(head.contentType).toBe('application/json');
      expect(head.checksum).toMatch(/^[0-9a-f]{64}$/);
    });

    it.each(['../escape.txt', 'a/../escape.txt', 'a/./b.txt', 'a//b.txt', 'a\\..\\b.txt', '/abs.txt', ''])(
      'rejects non-canonical or traversal key %p',
      async (key) => {
        await expect(driver.put(key, Buffer.from('x'), { contentType: 'text/plain' })).rejects.toBeInstanceOf(
          InvalidObjectKeyError,
        );
      },
    );

    it('refuses to construct when the configured root does not exist', () => {
      const missing = join(tmpdir(), `bge-localdisk-missing-${Date.now()}`);
      expect(() => new LocalDiskDriver(makeConfig(missing), signer)).toThrow(StorageMisconfiguredError);
    });

    it('refuses to construct when the configured root is not a directory', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bge-localdisk-'));
      const filePath = join(dir, 'not-a-dir');
      await writeFile(filePath, 'x');
      expect(() => new LocalDiskDriver(makeConfig(filePath), signer)).toThrow(StorageMisconfiguredError);
      await rm(dir, { recursive: true, force: true });
    });
  });
});
