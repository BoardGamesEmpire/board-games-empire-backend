import type {
  ListOptions,
  ListResult,
  ObjectMeta,
  RetrievedObject,
  SignedUrl,
  SignedUrlOptions,
  StorageDriver,
  StorageOp,
  StoredObject,
} from '@boardgamesempire/storage-contract';
import { ObjectNotFoundError } from '@boardgamesempire/storage-contract';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

interface StoredEntry {
  readonly bytes: Buffer;
  readonly object: StoredObject;
}

/**
 * Reference in-memory `StorageDriver`. Test-only: validates the contract harness
 * and lets consumers exercise services without touching disk. Not for production.
 */
export class InMemoryStorageDriver implements StorageDriver {
  readonly slug = 'memory';
  private readonly store = new Map<string, StoredEntry>();

  async put(key: string, body: Readable | Buffer, meta: ObjectMeta): Promise<StoredObject> {
    const bytes = Buffer.isBuffer(body) ? body : await this.drain(body);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const object: StoredObject = {
      key,
      size: BigInt(bytes.byteLength),
      contentType: meta.contentType,
      checksum,
      etag: checksum,
      lastModified: new Date(),
      driverSlug: this.slug,
    };
    this.store.set(key, { bytes, object });
    return object;
  }

  async get(key: string): Promise<RetrievedObject> {
    const entry = this.require(key);
    return { body: Readable.from(entry.bytes), metadata: entry.object };
  }

  async head(key: string): Promise<StoredObject> {
    return this.require(key).object;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async signedUrl(key: string, op: StorageOp, options: SignedUrlOptions): Promise<SignedUrl> {
    const expiresAt = new Date(Date.now() + options.ttlSeconds * 1000);
    const exp = Math.floor(expiresAt.getTime() / 1000);
    return {
      url: `memory://${this.slug}/${encodeURIComponent(key)}?op=${op}&exp=${exp}`,
      expiresAt,
      method: op === 'put' ? 'PUT' : 'GET',
    };
  }

  async list(prefix: string, options: ListOptions = {}): Promise<ListResult> {
    const { cursor, limit } = options;
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();

    const start = cursor ? keys.indexOf(cursor) + 1 : 0;
    const paged = limit && limit > 0;
    const page = paged ? keys.slice(start, start + limit) : keys.slice(start);

    const objects = page.map((k) => this.require(k).object);
    const nextCursor = paged && start + page.length < keys.length ? page[page.length - 1] : undefined;
    return { objects, nextCursor };
  }

  private require(key: string): StoredEntry {
    const entry = this.store.get(key);
    if (!entry) {
      throw new ObjectNotFoundError(key);
    }
    return entry;
  }

  private async drain(body: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }
}
