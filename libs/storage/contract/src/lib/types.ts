import type { Readable } from 'node:stream';

/** Operation a signed URL authorizes. */
export type StorageOp = 'get' | 'put';

/**
 * Addresses a stored object across drivers: `driverSlug` selects the backend,
 * `driverKey` locates the bytes within it. Required by every object-addressed op
 * (`get`/`head`/`delete`/`signedUrl`) so routing follows the object's recorded
 * driver, not the active write driver. Mirrors `MediaObject @@unique([driverSlug, driverKey])`.
 */
export interface StorageLocator {
  readonly driverKey: string;
  readonly driverSlug: string;
}

/** Caller-supplied metadata at write time. The driver computes authoritative size/checksum. */
export interface ObjectMeta {
  readonly cacheControl?: string;
  readonly contentType: string;
  readonly originalName?: string;
}

/** Authoritative metadata for a stored object. `size` is bigint to match persisted `sizeBytes`. */
export interface StoredObject {
  readonly checksum: string; // sha256 hex
  readonly contentType: string;

  /** Driver-specific extras, discriminated by `driverSlug`. Opaque to consumers. */
  readonly details?: Readonly<Record<string, unknown>>;

  readonly driverSlug: string;
  readonly etag?: string;
  readonly key: string;
  readonly lastModified: Date;
  readonly size: bigint;
}

/** Result of a streaming read: the body plus the object's metadata. */
export interface RetrievedObject {
  readonly body: Readable;
  readonly metadata: StoredObject;
}

/** Values bound into a signed URL's signature (never serialized into the URL itself). */
export interface SignedUrlOptions {
  /** Extra claims folded into the signature (e.g. `{ ownerId }`). App-served drivers MUST bind these. */
  readonly bindings?: Readonly<Record<string, string>>;

  /** Bound into the signature and enforced as the response Content-Type by app-served drivers. */
  readonly contentType?: string;

  readonly ttlSeconds: number;
}

export interface SignedUrl {
  readonly expiresAt: Date;
  readonly method: 'GET' | 'PUT';
  readonly url: string;
}

export interface ListOptions {
  /** Resume after this key (from a prior `ListResult.nextCursor`). */
  readonly cursor?: string;

  /** Max objects per page. Omit to return all matches in one page (no `nextCursor`). */
  readonly limit?: number;
}

export interface ListResult {
  /** Present only when more objects remain beyond this page; pass back as `ListOptions.cursor`. */
  readonly nextCursor?: string;

  readonly objects: readonly StoredObject[];
}
