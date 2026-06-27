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
import { InvalidObjectKeyError, ObjectNotFoundError } from '@boardgamesempire/storage-contract';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MediaUrlSigner } from './media-url-signer.js';
import type { MediaConfig } from './media.config.js';

const SIDECAR_SUFFIX = '.meta.json';

interface Sidecar {
  readonly contentType: string;
  readonly checksum: string;
  readonly etag: string;
  readonly originalName?: string;
}

// jest runs specs in a VM realm whose `Error` differs from the host `Error`
// that node core modules (fs) throw, so `instanceof Error` is unreliable here.
// Detect the errno by duck-typing `.code` instead.
const isENOENT = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Bundled zero-config driver: stores bytes under a configurable filesystem root,
 * with a `.meta.json` sidecar per object for content-type/checksum (so `head` is
 * cheap and never re-hashes). `signedUrl` mints a short-lived HMAC URL at the
 * internal streaming route; verification is performed by that controller via
 * `MediaUrlSigner`. Keys are sandboxed to the root — traversal is rejected.
 */
@Injectable()
export class LocalDiskDriver implements StorageDriver {
  readonly slug = 'localdisk';
  private readonly root: string;
  private readonly baseUrl: string;
  private readonly streamPath: string;

  constructor(
    config: ConfigService,
    private readonly signer: MediaUrlSigner,
  ) {
    const media = config.getOrThrow<MediaConfig>('media');
    this.root = resolve(media.localDiskRoot);
    this.baseUrl = media.baseUrl.replace(/\/+$/, '');
    this.streamPath = media.streamPath;
  }

  async put(key: string, body: Readable | Buffer, meta: ObjectMeta): Promise<StoredObject> {
    const filePath = this.resolveKey(key);
    await mkdir(dirname(filePath), { recursive: true });

    const hash = createHash('sha256');
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    const source = Buffer.isBuffer(body) ? Readable.from(body) : body;
    await pipeline(source, meter, createWriteStream(filePath));

    const checksum = hash.digest('hex');
    const sidecar: Sidecar = {
      contentType: meta.contentType,
      checksum,
      etag: checksum,
      originalName: meta.originalName,
    };
    await writeFile(this.sidecarPath(filePath), JSON.stringify(sidecar), 'utf8');

    const info = await stat(filePath);
    return this.toStoredObject(key, BigInt(info.size), sidecar, info.mtime);
  }

  async get(key: string): Promise<RetrievedObject> {
    const metadata = await this.head(key); // throws ObjectNotFoundError when absent
    return { body: createReadStream(this.resolveKey(key)), metadata };
  }

  async head(key: string): Promise<StoredObject> {
    const filePath = this.resolveKey(key);
    const [info, sidecar] = await Promise.all([this.statOrThrow(key, filePath), this.readSidecar(key, filePath)]);
    return this.toStoredObject(key, BigInt(info.size), sidecar, info.mtime);
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolveKey(key);
    await rm(filePath, { force: true });
    await rm(this.sidecarPath(filePath), { force: true });
  }

  async signedUrl(key: string, op: StorageOp, options: SignedUrlOptions): Promise<SignedUrl> {
    this.assertCanonicalKey(key); // never mint a URL for a non-canonical / traversal key (finding 1)
    if (!Number.isFinite(options.ttlSeconds) || options.ttlSeconds <= 0) {
      throw new RangeError(`signedUrl ttlSeconds must be a positive, finite number; received ${options.ttlSeconds}`);
    }

    const expiresAt = Math.floor(Date.now() / 1000) + Math.floor(options.ttlSeconds);
    const signature = await this.signer.sign({
      key,
      op,
      expiresAt,
      contentType: options.contentType,
      bindings: options.bindings,
    });

    const params = new URLSearchParams({ key, op, exp: String(expiresAt), sig: signature });
    return {
      url: `${this.baseUrl}${this.streamPath}?${params.toString()}`,
      expiresAt: new Date(expiresAt * 1000),
      method: op === 'put' ? 'PUT' : 'GET',
    };
  }

  async list(prefix: string, options: ListOptions = {}): Promise<ListResult> {
    const { cursor, limit } = options;
    // Constrain the walk to the prefix's directory subtree, then filter — avoids
    // a full-root scan. walk() yields root-relative keys regardless of start dir.
    const keys = (await this.walk(this.resolvePrefixDir(prefix))).filter((k) => k.startsWith(prefix)).sort();

    const start = cursor ? keys.indexOf(cursor) + 1 : 0; // -1 + 1 = 0: unknown cursor restarts
    const paged = limit && limit > 0;
    const page = paged ? keys.slice(start, start + limit) : keys.slice(start);

    const objects = await Promise.all(page.map((k) => this.head(k)));
    const nextCursor = paged && start + page.length < keys.length ? page[page.length - 1] : undefined;
    return { objects, nextCursor };
  }
  private resolveKey(key: string): string {
    this.assertCanonicalKey(key);
    // No `..`, leading-slash, or backslash segments survive the guard, so the
    // resolved path is always within root — no post-resolve escape check needed.
    return resolve(this.root, key);
  }

  private resolvePrefixDir(prefix: string): string {
    this.assertCanonicalPrefix(prefix);
    const slash = prefix.lastIndexOf('/');
    const dirPart = slash >= 0 ? prefix.slice(0, slash) : '';
    return resolve(this.root, dirPart);
  }

  /**
   * Keys must be canonical, stable identifiers: non-empty, no empty/`.`/`..`
   * segments (which alias or traverse), and no backslashes (separator confusion).
   */
  private assertCanonicalKey(key: string): void {
    if (key === '' || key.includes('\\')) {
      throw new InvalidObjectKeyError(key);
    }
    for (const segment of key.split('/')) {
      if (segment === '' || segment === '.' || segment === '..') {
        throw new InvalidObjectKeyError(key);
      }
    }
  }

  /**
   * Validates the full list prefix (finding 3) — not just the directory part.
   * Allows an empty prefix (list all; authorization is the caller's concern,
   * finding 6) and a single trailing slash (`media/`), but rejects `.`/`..`
   * segments, internal empty segments (`a//b`), and backslashes.
   */
  private assertCanonicalPrefix(prefix: string): void {
    if (prefix === '') {
      return;
    }
    if (prefix.includes('\\')) {
      throw new InvalidObjectKeyError(prefix);
    }
    const segments = prefix.split('/');
    segments.forEach((segment, index) => {
      if (segment === '.' || segment === '..') {
        throw new InvalidObjectKeyError(prefix);
      }
      if (segment === '' && index !== segments.length - 1) {
        throw new InvalidObjectKeyError(prefix);
      }
    });
  }

  private sidecarPath(filePath: string): string {
    return `${filePath}${SIDECAR_SUFFIX}`;
  }

  private toStoredObject(key: string, size: bigint, sidecar: Sidecar, lastModified: Date): StoredObject {
    return {
      key,
      size,
      contentType: sidecar.contentType,
      checksum: sidecar.checksum,
      etag: sidecar.etag,
      lastModified,
      driverSlug: this.slug,
    };
  }

  private async statOrThrow(key: string, filePath: string): Promise<Stats> {
    try {
      return await stat(filePath);
    } catch (error) {
      if (isENOENT(error)) {
        throw new ObjectNotFoundError(key, { cause: error });
      }
      throw error;
    }
  }

  private async readSidecar(key: string, filePath: string): Promise<Sidecar> {
    try {
      return JSON.parse(await readFile(this.sidecarPath(filePath), 'utf8')) as Sidecar;
    } catch (error) {
      if (isENOENT(error)) {
        throw new ObjectNotFoundError(key, { cause: error });
      }
      throw error;
    }
  }

  private async walk(dir: string): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isENOENT(error)) {
        return []; // fresh root that hasn't been written to yet
      }
      throw error;
    }

    const keys: string[] = [];
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        keys.push(...(await this.walk(abs)));
      } else if (!entry.name.endsWith(SIDECAR_SUFFIX)) {
        keys.push(relative(this.root, abs).split(sep).join('/'));
      }
    }

    return keys;
  }
}
