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
import { ObjectNotFoundError, type StorageError } from '@boardgamesempire/storage-contract';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

interface StoredEntry {
  readonly bytes: Buffer;
  readonly object: StoredObject;
}

/** Driver methods whose failure can be simulated. `signedUrl` is excluded: it's
 *  pure HMAC and never touches storage, so it can't fail on availability grounds. */
export type FaultableMethod = 'put' | 'get' | 'head' | 'delete' | 'list' | 'ping';

/**
 * Reference in-memory `StorageDriver`. Test-only: validates the contract harness
 * and lets consumers exercise services without touching disk. Not for production.
 */
export class InMemoryStorageDriver implements StorageDriver {
  readonly slug = 'memory';
  private readonly store = new Map<string, StoredEntry>();
  private readonly faults = new Map<FaultableMethod | 'all', StorageError>();

  /**
   * Test hook: make `method` (or every faultable method, with `'all'`) reject
   * with `error`. Pass `null` to clear. A method-specific fault wins over `'all'`.
   */
  setFault(method: FaultableMethod | 'all', error: StorageError | null): void {
    if (error) {
      this.faults.set(method, error);
    } else {
      this.faults.delete(method);
    }
  }

  private throwIfFaulted(method: FaultableMethod): void {
    const fault = this.faults.get(method) ?? this.faults.get('all');
    if (fault) {
      throw fault;
    }
  }

  async put(key: string, body: Readable | Buffer, meta: ObjectMeta): Promise<StoredObject> {
    this.throwIfFaulted('put');
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
    this.throwIfFaulted('get');
    const entry = this.require(key);
    return { body: Readable.from(entry.bytes), metadata: entry.object };
  }

  async head(key: string): Promise<StoredObject> {
    this.throwIfFaulted('head');
    return this.require(key).object;
  }

  async delete(key: string): Promise<void> {
    this.throwIfFaulted('delete');
    this.store.delete(key);
  }

  async ping(): Promise<void> {
    this.throwIfFaulted('ping');
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
    this.throwIfFaulted('list');
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
