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
  readonly driverSlug: string;
  readonly driverKey: string;
}

/** Caller-supplied metadata at write time. The driver computes authoritative size/checksum. */
export interface ObjectMeta {
  readonly contentType: string;
  readonly originalName?: string;
  readonly cacheControl?: string;
}

/** Authoritative metadata for a stored object. `size` is bigint to match persisted `sizeBytes`. */
export interface StoredObject {
  readonly key: string;
  readonly size: bigint;
  readonly contentType: string;
  readonly checksum: string; // sha256 hex
  readonly etag?: string;
  readonly lastModified: Date;
  readonly driverSlug: string;
  /** Driver-specific extras, discriminated by `driverSlug`. Opaque to consumers. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Result of a streaming read: the body plus the object's metadata. */
export interface RetrievedObject {
  readonly body: Readable;
  readonly metadata: StoredObject;
}

/** Values bound into a signed URL's signature (never serialized into the URL itself). */
export interface SignedUrlOptions {
  readonly ttlSeconds: number;
  /** Bound into the signature and enforced as the response Content-Type by app-served drivers. */
  readonly contentType?: string;
  /** Extra claims folded into the signature (e.g. `{ ownerId }`). App-served drivers MUST bind these. */
  readonly bindings?: Readonly<Record<string, string>>;
}

export interface SignedUrl {
  readonly url: string;
  readonly expiresAt: Date;
  readonly method: 'GET' | 'PUT';
}

export interface ListOptions {
  /** Resume after this key (from a prior `ListResult.nextCursor`). */
  readonly cursor?: string;
  /** Max objects per page. Omit to return all matches in one page (no `nextCursor`). */
  readonly limit?: number;
}

export interface ListResult {
  readonly objects: readonly StoredObject[];
  /** Present only when more objects remain beyond this page; pass back as `ListOptions.cursor`. */
  readonly nextCursor?: string;
}
