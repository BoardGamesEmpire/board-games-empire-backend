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
import {
  InsufficientStorageError,
  InvalidObjectKeyError,
  ObjectNotFoundError,
  StorageMisconfiguredError,
  StorageUnavailableError,
} from '@boardgamesempire/storage-contract';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
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
  private readonly logger = new Logger(LocalDiskDriver.name);

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
    this.logger.debug(`LocalDiskDriver root: ${this.root}`);
    this.assertRootExists();
  }

  async put(key: string, body: Readable | Buffer, meta: ObjectMeta): Promise<StoredObject> {
    const filePath = this.resolveKey(key); // validation only — keep outside the I/O try

    try {
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
    } catch (error) {
      // "A failed put leaves no bytes": drop any partial data/sidecar before
      // translating, so a disk-full write doesn't strand a half-written object.
      await rm(filePath, { force: true }).catch(() => undefined);
      await rm(this.sidecarPath(filePath), { force: true }).catch(() => undefined);
      throw this.classify(error, key) ?? error;
    }
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
    try {
      await rm(filePath, { force: true });
      await rm(this.sidecarPath(filePath), { force: true });
    } catch (error) {
      throw this.classify(error, key) ?? error;
    }
  }

  async signedUrl(key: string, op: StorageOp, options: SignedUrlOptions): Promise<SignedUrl> {
    this.assertCanonicalKey(key); // never mint a URL for a non-canonical / traversal key
    if (!Number.isFinite(options.ttlSeconds) || options.ttlSeconds <= 0) {
      throw new RangeError(`signedUrl ttlSeconds must be a positive, finite number; received ${options.ttlSeconds}`);
    }

    const expiresAt = Math.floor(Date.now() / 1000) + Math.floor(options.ttlSeconds);
    const signature = await this.signer.sign({
      slug: this.slug,
      key,
      op,
      expiresAt,
      contentType: options.contentType,
      bindings: options.bindings,
    });

    const params = new URLSearchParams({ slug: this.slug, key, op, exp: String(expiresAt), sig: signature });
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
   * Validates the full list prefix — not just the directory part.
   * Allows an empty prefix (list all; authorization is the caller's concern,
   * and a single trailing slash (`media/`), but rejects `.`/`..`
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
        throw await this.classifyEnoent(error, key);
      }
      throw this.classify(error, key) ?? error;
    }
  }

  private async readSidecar(key: string, filePath: string): Promise<Sidecar> {
    try {
      return JSON.parse(await readFile(this.sidecarPath(filePath), 'utf8')) as Sidecar;
    } catch (error) {
      if (isENOENT(error)) {
        throw await this.classifyEnoent(error, key);
      }

      throw this.classify(error, key) ?? error;
    }
  }

  /**
   * Translates a native errno failure into the portable storage vocabulary so
   * callers never sniff `error.code`. Returns `undefined` for codes we don't
   * model — the caller rethrows the original, so a genuinely unexpected failure
   * still surfaces as a 500 (fail loud) rather than masquerading as a 503.
   *
   * ENOENT is deliberately absent: for object reads it means "missing key",
   * resolved by `classifyEnoent` (which probes the root to tell an absent object
   * from an unmounted volume).
   */
  private classify(error: unknown, key: string): InsufficientStorageError | StorageUnavailableError | undefined {
    switch ((error as NodeJS.ErrnoException | null)?.code) {
      case 'ENOSPC':
      case 'EDQUOT':
        return new InsufficientStorageError(`No space left while accessing '${key}'`, { cause: error });
      case 'EIO':
        return new StorageUnavailableError(`Storage I/O error while accessing '${key}'`, {
          retryable: true,
          cause: error,
        });
      case 'EACCES':
      case 'EPERM':
        return new StorageUnavailableError(`Storage permission denied while accessing '${key}'`, {
          retryable: false,
          cause: error,
        });
      default:
        return undefined;
    }
  }

  /**
   * Disambiguates an ENOENT on an object path: a genuinely missing key
   * (`ObjectNotFoundError`, unchanged) vs an unreachable root. Probes the root
   * once, only on this already-failing path, and preserves the root failure's
   * retryability — a missing/unmounted root is retryable, but EACCES/EPERM on
   * the root is not (matching `classify`).
   */
  private async classifyEnoent(error: unknown, key: string): Promise<ObjectNotFoundError | StorageUnavailableError> {
    const rootFailure = await this.probeRoot();
    return rootFailure ?? new ObjectNotFoundError(key, { cause: error });
  }

  /**
   * Reachability probe for the root. Returns `undefined` when the root is a
   * healthy directory; otherwise a `StorageUnavailableError` carrying the
   * correct retryability: permission errors (EACCES/EPERM) and I/O errors are
   * classified by the shared helper (non-retryable / retryable respectively),
   * and a missing root (ENOENT — unmounted volume) is retryable.
   */
  private async probeRoot(): Promise<StorageUnavailableError | undefined> {
    try {
      await stat(this.root);
      return undefined;
    } catch (error) {
      const classified = this.classify(error, this.root);
      if (classified instanceof StorageUnavailableError) {
        return classified;
      }

      return new StorageUnavailableError('Storage root is unavailable (unmounted?)', { retryable: true, cause: error });
    }
  }

  private async walk(dir: string): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isENOENT(error)) {
        // A missing prefix subtree under a healthy root is normal (no objects
        // there). A root that's gone/unreachable surfaces with the right
        // retryability instead of a misleading "empty".
        const rootFailure = await this.probeRoot();
        if (!rootFailure) {
          return [];
        }

        throw rootFailure;
      }

      throw this.classify(error, dir) ?? error;
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

  async ping(): Promise<void> {
    const rootFailure = await this.probeRoot();
    if (rootFailure) {
      this.logger.error(rootFailure.message, rootFailure.stack);
      throw rootFailure;
    }
  }

  /**
   * The root is operator-provisioned infrastructure (a mount point / volume),
   * not the driver's to create. Asserting it at construction turns a missing or
   * misconfigured path into a loud bootstrap failure, rather than letting `put`'s
   * recursive `mkdir` silently recreate it on the underlying filesystem and
   * accept writes that vanish on remount. Per-object key subdirectories are
   * still created on demand — those are ours to manage. Sync stat is fine: it
   * runs once at DI construction, never on the request path.
   */
  private assertRootExists(): void {
    let stats: Stats;
    try {
      stats = statSync(this.root);
    } catch (error) {
      throw new StorageMisconfiguredError(
        `media.localDiskRoot '${this.root}' does not exist or is unreadable; the storage volume must be provisioned before startup`,
        { cause: error },
      );
    }
    if (!stats.isDirectory()) {
      throw new StorageMisconfiguredError(`media.localDiskRoot '${this.root}' is not a directory`);
    }
  }
}
