import { ObjectNotFoundError, type StorageDriver } from '@boardgamesempire/storage-contract';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

/** What a driver-under-test exposes to the harness, plus optional teardown. */
export interface DriverUnderTest {
  readonly driver: StorageDriver;
  readonly teardown?: () => void | Promise<void>;
}

export interface StorageContractOptions {
  /** Skip signed-URL assertions for drivers that don't mint URLs. */
  readonly skipSignedUrl?: boolean;
}

async function drain(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Shared behavioral contract every `StorageDriver` must satisfy. Call inside a
 * test file with a factory that returns a fresh driver (and optional teardown)
 * per test:
 *
 *   runStorageDriverContract(() => ({ driver: new InMemoryStorageDriver() }));
 */
export function runStorageDriverContract(
  setup: () => DriverUnderTest | Promise<DriverUnderTest>,
  options: StorageContractOptions = {},
): void {
  describe('StorageDriver contract', () => {
    let driver: StorageDriver;
    let teardown: (() => void | Promise<void>) | undefined;

    const body = Buffer.from('the quick brown fox', 'utf8');
    const meta = { contentType: 'text/plain', originalName: 'fox.txt' } as const;

    beforeEach(async () => {
      const ctx = await setup();
      driver = ctx.driver;
      teardown = ctx.teardown;
    });

    afterEach(async () => {
      await teardown?.();
    });

    it('put returns authoritative size, checksum, and slug', async () => {
      const stored = await driver.put('docs/fox.txt', body, meta);
      expect(stored.key).toBe('docs/fox.txt');
      expect(stored.size).toBe(BigInt(body.byteLength));
      expect(stored.checksum).toBe(sha256(body));
      expect(stored.contentType).toBe('text/plain');
      expect(stored.driverSlug).toBe(driver.slug);
    });

    it('head after put returns matching metadata', async () => {
      const put = await driver.put('docs/fox.txt', body, meta);
      const head = await driver.head('docs/fox.txt');
      expect(head).toEqual(
        expect.objectContaining({ key: put.key, size: put.size, checksum: put.checksum, contentType: put.contentType }),
      );
    });

    it('get streams back identical bytes', async () => {
      await driver.put('docs/fox.txt', body, meta);
      const { body: stream, metadata } = await driver.get('docs/fox.txt');
      expect((await drain(stream)).equals(body)).toBe(true);
      expect(metadata.checksum).toBe(sha256(body));
    });

    it('accepts a Readable body', async () => {
      const stored = await driver.put('docs/stream.txt', Readable.from(body), meta);
      expect(stored.checksum).toBe(sha256(body));
    });

    it('head throws ObjectNotFoundError for a missing key', async () => {
      await expect(driver.head('missing')).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    it('get throws ObjectNotFoundError for a missing key', async () => {
      await expect(driver.get('missing')).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    it('delete is idempotent and removes the object', async () => {
      await driver.put('docs/fox.txt', body, meta);
      await driver.delete('docs/fox.txt');
      await expect(driver.head('docs/fox.txt')).rejects.toBeInstanceOf(ObjectNotFoundError);
      await expect(driver.delete('docs/fox.txt')).resolves.toBeUndefined();
    });

    it('list returns objects under a prefix', async () => {
      await driver.put('a/one.txt', body, meta);
      await driver.put('a/two.txt', body, meta);
      await driver.put('b/three.txt', body, meta);
      const { objects } = await driver.list('a/');
      expect(objects.map((o) => o.key).sort()).toEqual(['a/one.txt', 'a/two.txt']);
    });

    it('paginates with limit and nextCursor', async () => {
      await driver.put('a/one.txt', body, meta);
      await driver.put('a/two.txt', body, meta);
      await driver.put('a/three.txt', body, meta); // sorts: one, three, two

      const first = await driver.list('a/', { limit: 2 });
      expect(first.objects).toHaveLength(2);
      expect(first.nextCursor).toBeDefined();

      const second = await driver.list('a/', { cursor: first.nextCursor, limit: 2 });
      expect(second.objects).toHaveLength(1);
      expect(second.nextCursor).toBeUndefined();

      const firstKeys = first.objects.map((o) => o.key);
      expect(firstKeys).not.toContain(second.objects[0].key); // no overlap across pages
    });

    it('returns all matches in one page when no limit is given', async () => {
      await driver.put('a/one.txt', body, meta);
      await driver.put('a/two.txt', body, meta);
      const { objects, nextCursor } = await driver.list('a/');
      expect(objects).toHaveLength(2);
      expect(nextCursor).toBeUndefined();
    });

    it('ping resolves for a healthy driver', async () => {
      await expect(driver.ping()).resolves.toBeUndefined();
    });

    if (!options.skipSignedUrl) {
      it('signedUrl returns a future expiry and matching method', async () => {
        await driver.put('docs/fox.txt', body, meta);
        const signed = await driver.signedUrl('docs/fox.txt', 'get', { ttlSeconds: 300 });
        expect(signed.method).toBe('GET');
        expect(signed.expiresAt.getTime()).toBeGreaterThan(Date.now());
        expect(typeof signed.url).toBe('string');
      });
    }
  });
}
