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
import type { MediaConfig, MountCheckMode } from './media.config.js';

const SIDECAR_SUFFIX = '.meta.json';

interface Sidecar {
  readonly contentType: string;
  readonly checksum: string;
  readonly etag: string;
  readonly originalName?: string;
}

/** Effective mount-check strategy after `auto` has been resolved at construction. */
type ResolvedMountCheck = 'st_dev' | 'sentinel' | 'off';

// jest runs specs in a VM realm whose `Error` differs from the host `Error`
// that node core modules (fs) throw, so `instanceof Error` is unreliable here.
// Detect the errno by duck-typing `.code` instead.
const isENOENT = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Raised by `withProbeTimeout` when a reachability probe exceeds its budget —
 * distinct from an errno failure because the underlying syscall never returned
 * (a hung mount), which is the signal the fatal watchdog counts. Thrown by our
 * own code, so `instanceof` is realm-safe (unlike the fs errors above).
 */
class ProbeTimeoutError extends Error {
  constructor(
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(`Storage probe timed out after ${timeoutMs}ms accessing '${path}' (unreachable mount?)`);
    this.name = 'ProbeTimeoutError';
  }
}

/**
 * Bundled zero-config driver: stores bytes under a configurable filesystem root,
 * with a `.meta.json` sidecar per object for content-type/checksum (so `head` is
 * cheap and never re-hashes). `signedUrl` mints a short-lived HMAC URL at the
 * internal streaming route; verification is performed by that controller via
 * `MediaUrlSigner`. Keys are sandboxed to the root — traversal is rejected.
 *
 * Runtime unmount detection (see {@link MountCheckMode}): a clean `umount` leaves
 * the mountpoint directory in place, so a bare `stat(root)` can't tell a live
 * mount from a detached one. `probeRoot()` additionally compares the root's
 * device id against a boot baseline (`st_dev`/`auto`) or checks an operator
 * sentinel file, and `put()` probes proactively before writing so bytes are never
 * written to a phantom directory that vanishes on remount.
 */
@Injectable()
export class LocalDiskDriver implements StorageDriver {
  private readonly logger = new Logger(LocalDiskDriver.name);

  readonly slug = 'localdisk';
  private readonly root: string;
  private readonly baseUrl: string;
  private readonly streamPath: string;

  private readonly mountCheck: ResolvedMountCheck;
  /** Root `st_dev` captured at construction; set only in `st_dev` mode. Immutable by design. */
  private readonly deviceBaseline: number | undefined;
  /** Absolute sentinel path; set only in `sentinel` mode. */
  private readonly sentinelPath: string | undefined;
  private readonly probeTimeoutMs: number;
  private readonly fatalThreshold: number;
  private consecutiveTimeouts = 0;
  /** Shared in-flight probe so concurrent callers dedupe onto one stat() + one counter update. */
  private inFlightProbe: Promise<StorageUnavailableError | undefined> | null = null;

  constructor(
    config: ConfigService,
    private readonly signer: MediaUrlSigner,
  ) {
    const media = config.getOrThrow<MediaConfig>('media');
    this.root = resolve(media.localDiskRoot);
    this.baseUrl = media.baseUrl.replace(/\/+$/, '');
    this.streamPath = media.streamPath;
    this.probeTimeoutMs = media.probeTimeoutMs;
    this.fatalThreshold = media.probeTimeoutFatalThreshold;
    this.logger.debug(`LocalDiskDriver root: ${this.root}`);

    const rootStats = this.assertRootExists();
    const resolved = this.resolveMountCheck(media.mountCheck, rootStats, media.sentinelFile);
    this.mountCheck = resolved.mode;
    this.deviceBaseline = resolved.baseline;
    this.sentinelPath = resolved.sentinelPath;
  }

  async put(key: string, body: Readable | Buffer, meta: ObjectMeta): Promise<StoredObject> {
    const filePath = this.resolveKey(key); // validation only — keep outside the I/O try

    // Fail loud *before* creating anything if the provisioned volume isn't mounted.
    // The unmount case is a successful write to the underlying disk (mkdir/write
    // don't error), so it can't be caught below — it must be a proactive probe.
    // Skipped when detection is off, preserving the original zero-overhead path.
    if (this.mountCheck !== 'off') {
      const mountFailure = await this.probeRoot();
      if (mountFailure) {
        throw mountFailure;
      }
    }

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
   * Reachability + mount-identity probe for the root. Returns `undefined` when the
   * root is a healthy, correctly-mounted directory; otherwise a
   * `StorageUnavailableError` with the right retryability. This is the single
   * consolidation point: readiness (`ping`), the write-path guard, and the
   * object-read ENOENT fallback all route through it.
   *
   * Covers three failure classes:
   *  - path failures — permission (EACCES/EPERM, non-retryable), I/O (EIO,
   *    retryable), or a missing root (ENOENT — unmounted, retryable);
   *  - a hung probe (unreachable NFS) — bounded by `probeTimeoutMs` and counted
   *    by the fatal watchdog;
   *  - a wrong/absent mount — device-id drift (`st_dev`) or a missing sentinel.
   *
   * Concurrent callers (readiness + parallel writes/reads) share a single
   * in-flight probe: only one `stat()` is active at a time — so a hung mount
   * doesn't multiply libuv-threadpool pressure — and the consecutive-timeout
   * counter is advanced by one serialized probe round at a time rather than
   * raced across parallel calls.
   *
   * Never throws: callers treat it as returning a value.
   */
  private async probeRoot(): Promise<StorageUnavailableError | undefined> {
    if (this.inFlightProbe) {
      return this.inFlightProbe;
    }

    this.inFlightProbe = this.runProbe();
    try {
      return await this.inFlightProbe;
    } finally {
      this.inFlightProbe = null;
    }
  }

  private async runProbe(): Promise<StorageUnavailableError | undefined> {
    try {
      const failure = await this.doProbe();
      this.consecutiveTimeouts = 0; // a completed probe (pass or classified fail) means no hang
      return failure;
    } catch (error) {
      if (error instanceof ProbeTimeoutError) {
        return this.handleProbeTimeout(error);
      }

      return new StorageUnavailableError('Unexpected storage probe failure', { retryable: true, cause: error });
    }
  }

  /**
   * The probe body. Resolves to a classified failure (or `undefined` when
   * healthy) for anything that *returned*, and throws `ProbeTimeoutError` when a
   * syscall hung — so `probeRoot` can keep the consecutive-timeout counter.
   */
  private async doProbe(): Promise<StorageUnavailableError | undefined> {
    let rootStats: Stats;
    try {
      rootStats = await this.withProbeTimeout(stat(this.root), this.root);
    } catch (error) {
      if (error instanceof ProbeTimeoutError) {
        throw error;
      }

      // Permission/I/O errors carry their own retryability from the shared helper.
      const classified = this.classify(error, this.root);
      if (classified instanceof StorageUnavailableError) {
        return classified;
      }

      // ENOENT is the actual unmount signal, so only it earns the "unmounted?"
      // label. Any other unmodeled errno bubbles to probeRoot's generic handler
      // rather than being mislabeled as an unmount.
      if (isENOENT(error)) {
        return new StorageUnavailableError('Storage root is unavailable (unmounted?)', {
          retryable: true,
          cause: error,
        });
      }

      throw error;
    }

    return this.checkMount(rootStats);
  }

  /**
   * Verifies the resolved root is the volume we baselined at boot. `st_dev`
   * compares device ids; `sentinel` checks the operator marker; `off` is a no-op.
   */
  private async checkMount(rootStats: Stats): Promise<StorageUnavailableError | undefined> {
    switch (this.mountCheck) {
      case 'st_dev':
        if (rootStats.dev !== this.deviceBaseline) {
          return new StorageUnavailableError(
            `Storage root device changed (baseline dev ${this.deviceBaseline}, now ${rootStats.dev}); ` +
              `the provisioned volume is not mounted at '${this.root}'`,
            { retryable: true },
          );
        }
        return undefined;
      case 'sentinel':
        return this.checkSentinel();
      default:
        return undefined;
    }
  }

  private async checkSentinel(): Promise<StorageUnavailableError | undefined> {
    const sentinelPath = this.sentinelPath;
    if (!sentinelPath) {
      return undefined; // unreachable: sentinel mode always resolves a path at construction
    }

    try {
      await this.withProbeTimeout(stat(sentinelPath), sentinelPath);
      return undefined;
    } catch (error) {
      if (error instanceof ProbeTimeoutError) {
        throw error;
      }

      // Preserve retryability for permission/I/O failures on the sentinel
      // (EACCES/EPERM non-retryable, EIO retryable) — matching the root path.
      const classified = this.classify(error, sentinelPath);
      if (classified instanceof StorageUnavailableError) {
        return classified;
      }

      // Only a genuinely absent marker (ENOENT) means the volume isn't the one we
      // provisioned; any other unmodeled errno bubbles to probeRoot's generic
      // handler rather than being mislabeled as a missing sentinel.
      if (isENOENT(error)) {
        return new StorageUnavailableError(
          `Storage sentinel '${sentinelPath}' is missing; the provisioned volume is not mounted at '${this.root}'`,
          { retryable: true, cause: error },
        );
      }

      throw error;
    }
  }

  /**
   * Bounds a single probe syscall. A blocked syscall (hung NFS hard mount) keeps
   * occupying its libuv threadpool slot even after this rejects — the timeout only
   * unblocks the caller so readiness can report down; the fatal watchdog handles
   * the eventual threadpool exhaustion. See the runtime README.
   */
  private async withProbeTimeout<T>(operation: Promise<T>, path: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ProbeTimeoutError(path, this.probeTimeoutMs)), this.probeTimeoutMs);
    });

    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Counts *consecutive* probe timeouts (reset by any completed probe). Past the
   * configured threshold the process self-exits so the orchestrator restarts it
   * and clears the libuv threadpool — the only reliable recovery, since a wedged
   * threadpool doesn't block the event loop and so is invisible to a liveness
   * probe. `fatalThreshold === 0` disables the watchdog.
   */
  private handleProbeTimeout(error: ProbeTimeoutError): StorageUnavailableError {
    this.consecutiveTimeouts += 1;
    this.logger.error(`${error.message} (${this.consecutiveTimeouts} consecutive timeout(s))`);

    if (this.fatalThreshold > 0 && this.consecutiveTimeouts >= this.fatalThreshold) {
      this.logger.error(
        `FATAL: ${this.consecutiveTimeouts} consecutive storage probe timeouts; the libuv threadpool is likely ` +
          `exhausted by a hung mount (async fs and DNS would stall process-wide). Exiting so the orchestrator ` +
          `restarts this process and clears the threadpool.`,
      );
      this.exitProcess();
    }

    return new StorageUnavailableError(error.message, { retryable: true, cause: error });
  }

  /**
   * Fatal-watchdog seam. Overridable in tests. Deliberately a hard `process.exit`
   * rather than a graceful Nest shutdown: when the threadpool is wedged by a hung
   * mount, graceful teardown would itself block on async I/O.
   */
  protected exitProcess(): void {
    process.exit(1);
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
   * runs once at DI construction, never on the request path. Returns the root
   * `Stats` so the caller can baseline `st_dev` without a second stat.
   */
  private assertRootExists(): Stats {
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
    return stats;
  }

  /**
   * Resolves the requested {@link MountCheckMode} into an effective strategy at
   * construction, capturing whatever boot-time state it needs (an `st_dev`
   * baseline, or a validated sentinel path). Boot-time only: the baseline is a
   * trusted observation of a known-good mount and must never be re-derived under
   * a running process.
   */
  private resolveMountCheck(
    requested: MountCheckMode,
    rootStats: Stats,
    sentinelFile: string,
  ): { mode: ResolvedMountCheck; baseline?: number; sentinelPath?: string } {
    switch (requested) {
      case 'off':
        this.logger.debug('Mount check disabled (off)');
        return { mode: 'off' };
      case 'st_dev':
        this.logger.debug(`Mount check: st_dev (baseline dev=${rootStats.dev})`);
        return { mode: 'st_dev', baseline: rootStats.dev };
      case 'sentinel': {
        const sentinelPath = this.resolveSentinelPath(sentinelFile);
        this.assertSentinelExists(sentinelPath);
        this.logger.debug(`Mount check: sentinel (${sentinelPath})`);
        return { mode: 'sentinel', sentinelPath };
      }
      case 'auto':
        return this.resolveAuto(rootStats);
      default:
        throw new StorageMisconfiguredError(`Unknown media.mountCheck mode '${String(requested)}'`);
    }
  }

  /**
   * `auto`: enable the device check only when the root is genuinely its own mount.
   * A mountpoint has a different `st_dev` than its parent directory; when they
   * match, the root shares a filesystem with its parent (local dev, a
   * non-dedicated disk, some bind mounts) and nothing an unmount would change — so
   * degrade to a no-op rather than baseline a device that can never legitimately
   * differ. Operators on NFS/overlay/bind, where `st_dev` is unreliable, should
   * select `sentinel` explicitly.
   */
  private resolveAuto(rootStats: Stats): { mode: 'st_dev' | 'off'; baseline?: number } {
    let parentDev: number;
    try {
      parentDev = statSync(dirname(this.root)).dev;
    } catch {
      this.logger.warn(
        `Mount check auto: could not stat the parent of '${this.root}' to detect a dedicated mount; ` +
          `disabling the device check`,
      );
      return { mode: 'off' };
    }

    if (rootStats.dev === parentDev) {
      // Expected when the root genuinely isn't a dedicated mount (local dev,
      // single-disk hosts). But it also happens when a *dedicated* volume isn't
      // mounted yet at boot: the empty mountpoint shares its parent's device, so
      // detection silently stays off for the process lifetime. Warn (not debug)
      // so an operator who intended a dedicated volume notices.
      this.logger.warn(
        `Mount check auto: '${this.root}' shares a filesystem with its parent (dev=${rootStats.dev}); ` +
          `runtime unmount detection is DISABLED. If this root is a dedicated volume, ensure it is mounted ` +
          `before startup or set MEDIA_LOCAL_DISK_MOUNT_CHECK=sentinel.`,
      );
      return { mode: 'off' };
    }

    this.logger.debug(
      `Mount check auto: '${this.root}' is a distinct mount; enabling st_dev (baseline dev=${rootStats.dev})`,
    );
    return { mode: 'st_dev', baseline: rootStats.dev };
  }

  /**
   * Enforces the same "bare filename" contract as the Joi env validation (no path
   * separators, and not `.`/`..`), so config that bypasses Joi (tests, direct
   * construction) still can't point the sentinel at the root itself or anywhere
   * but a marker directly under it — either would stay checkable while the volume
   * is unmounted, silently defeating the guard.
   */
  private resolveSentinelPath(sentinelFile: string): string {
    if (
      sentinelFile === '' ||
      sentinelFile === '.' ||
      sentinelFile === '..' ||
      sentinelFile.includes('/') ||
      sentinelFile.includes('\\')
    ) {
      throw new StorageMisconfiguredError(
        `media.sentinelFile '${sentinelFile}' must be a bare filename (no path separators, and not '.' or '..'), ` +
          `resolving to a marker directly under the storage root '${this.root}'`,
      );
    }
    return join(this.root, sentinelFile);
  }

  /**
   * Boot-time assertion for `sentinel` mode. A missing marker means the volume
   * isn't mounted (or wasn't provisioned) — fail loud with the exact remedy.
   * The driver never creates the sentinel: auto-creating it would let a restarted
   * pod re-mark an empty mountpoint on the underlying disk and reinstate the
   * silent-data-loss vector this whole feature closes.
   */
  private assertSentinelExists(sentinelPath: string): void {
    try {
      statSync(sentinelPath);
    } catch (error) {
      if (isENOENT(error)) {
        throw new StorageMisconfiguredError(
          `media.mountCheck is 'sentinel' but the sentinel file '${sentinelPath}' was not found. ` +
            `Ensure the storage volume is mounted, then create it: touch ${sentinelPath}`,
          { cause: error },
        );
      }

      // Non-ENOENT (EACCES/EPERM/EIO, …): the marker may exist but isn't readable
      // or the volume is unhealthy — don't send the operator to `touch`.
      const code = (error as NodeJS.ErrnoException | null)?.code ?? 'unknown error';
      throw new StorageMisconfiguredError(
        `media.mountCheck is 'sentinel' but the sentinel file '${sentinelPath}' could not be read (${code}); ` +
          `check the storage volume's health and permissions`,
        { cause: error },
      );
    }
  }
}
