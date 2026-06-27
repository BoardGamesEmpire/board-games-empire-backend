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
import { Inject, Injectable } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { STORAGE_DRIVER } from './storage.tokens.js';

/**
 * Single entry point onto the active storage driver. Consumers (the media
 * resource lib, sweep task, etc.) depend on this — never on a concrete driver —
 * so swapping drivers is a config change. Byte-level and key-based by design;
 * ownership/visibility bindings are composed by callers that hold the
 * `MediaObject` and passed via `signedUrl` options.
 */
@Injectable()
export class StorageService {
  constructor(@Inject(STORAGE_DRIVER) private readonly driver: StorageDriver) {}

  get driverSlug(): string {
    return this.driver.slug;
  }

  put(key: string, body: Readable | Buffer, meta: ObjectMeta): Promise<StoredObject> {
    return this.driver.put(key, body, meta);
  }

  get(key: string): Promise<RetrievedObject> {
    return this.driver.get(key);
  }

  head(key: string): Promise<StoredObject> {
    return this.driver.head(key);
  }

  delete(key: string): Promise<void> {
    return this.driver.delete(key);
  }

  signedUrl(key: string, op: StorageOp, options: SignedUrlOptions): Promise<SignedUrl> {
    return this.driver.signedUrl(key, op, options);
  }

  list(prefix: string, options?: ListOptions): Promise<ListResult> {
    return this.driver.list(prefix, options);
  }
}
