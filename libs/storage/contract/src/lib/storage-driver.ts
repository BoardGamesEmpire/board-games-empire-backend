import type { Buffer } from 'node:buffer';
import type { Readable } from 'node:stream';
import type {
  ListOptions,
  ListResult,
  ObjectMeta,
  RetrievedObject,
  SignedUrl,
  SignedUrlOptions,
  StorageOp,
  StoredObject,
} from './types.js';

/**
 * Byte-mover behind a stable interface. Implementations own only byte transport
 * and storage-level metadata; ownership, visibility, and CASL live on `MediaObject`.
 *
 * Implementations MUST:
 *  - compute an authoritative sha256 `checksum` and `size` during `put`
 *  - throw `ObjectNotFoundError` from `get`/`head` for unknown keys
 *  - treat `delete` as idempotent (no error if the key is already absent)
 */
export interface StorageDriver {
  /**
   * Stable identifier (e.g. 'localdisk'). Stamped onto `StoredObject.driverSlug`.
   */
  readonly slug: string;

  put(key: string, body: Readable | Buffer, meta: ObjectMeta): Promise<StoredObject>;
  get(key: string): Promise<RetrievedObject>;
  head(key: string): Promise<StoredObject>;
  delete(key: string): Promise<void>;
  signedUrl(key: string, op: StorageOp, options: SignedUrlOptions): Promise<SignedUrl>;
  list(prefix: string, options?: ListOptions): Promise<ListResult>;

  /**
   * Cheap liveness probe for readiness checks. Resolves if the backend is
   * reachable; throws a `StorageError` (typically `StorageUnavailableError`)
   * otherwise. MUST be read-only — no object is created, mutated, or deleted.
   */
  ping(): Promise<void>;
}
