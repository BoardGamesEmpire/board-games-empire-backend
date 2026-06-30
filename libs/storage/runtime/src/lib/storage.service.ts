import type {
  ListOptions,
  ListResult,
  ObjectMeta,
  RetrievedObject,
  SignedUrl,
  SignedUrlOptions,
  StorageDriver,
  StorageLocator,
  StorageOp,
  StoredObject,
} from '@boardgamesempire/storage-contract';
import { DriverNotRegisteredError, StorageMisconfiguredError } from '@boardgamesempire/storage-contract';
import { Inject, Injectable } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { STORAGE_DEFAULT_WRITE_SLUG, STORAGE_DRIVERS } from './storage.tokens.js';

/**
 * Routes byte ops to the driver that actually holds the object. `put` targets the
 * configured default-write driver and stamps its slug onto the returned
 * `StoredObject`; every object-addressed op resolves the driver by the
 * caller-supplied `StorageLocator.driverSlug`, so reads/deletes/signed-URLs follow
 * the object's recorded driver regardless of which driver is currently the write
 * default. An unregistered slug throws `DriverNotRegisteredError` — never a silent
 * wrong-driver op (#100). Misconfiguration (missing write driver, duplicate slug)
 * fails loudly at construction.
 */
@Injectable()
export class StorageService {
  private readonly drivers: ReadonlyMap<string, StorageDriver>;
  private readonly writeDriver: StorageDriver;

  constructor(
    @Inject(STORAGE_DRIVERS) drivers: readonly StorageDriver[],
    @Inject(STORAGE_DEFAULT_WRITE_SLUG) private readonly writeSlug: string,
  ) {
    this.drivers = StorageService.indexBySlug(drivers);

    const writeDriver = this.drivers.get(writeSlug);
    if (!writeDriver) {
      throw new StorageMisconfiguredError(
        `Default-write driver '${writeSlug}' is not registered; available: ${[...this.drivers.keys()].join(', ') || '(none)'}`,
      );
    }
    this.writeDriver = writeDriver;
  }

  /** Slug new writes are stamped with. */
  get defaultWriteSlug(): string {
    return this.writeSlug;
  }

  put(key: string, body: Readable | Buffer, meta: ObjectMeta): Promise<StoredObject> {
    return this.writeDriver.put(key, body, meta);
  }

  async get(locator: StorageLocator): Promise<RetrievedObject> {
    return this.resolve(locator.driverSlug).get(locator.driverKey);
  }

  async head(locator: StorageLocator): Promise<StoredObject> {
    return this.resolve(locator.driverSlug).head(locator.driverKey);
  }

  async delete(locator: StorageLocator): Promise<void> {
    await this.resolve(locator.driverSlug).delete(locator.driverKey);
  }

  async signedUrl(locator: StorageLocator, op: StorageOp, options: SignedUrlOptions): Promise<SignedUrl> {
    return this.resolve(locator.driverSlug).signedUrl(locator.driverKey, op, options);
  }

  /**
   * Lists under a prefix on the default-write driver. Listing isn't object-addressed
   * (it's an admin/maintenance op); a slug-scoped variant lands if a real second
   * driver needs enumerating — deferred under #100.
   */
  list(prefix: string, options?: ListOptions): Promise<ListResult> {
    return this.writeDriver.list(prefix, options);
  }

  private resolve(slug: string): StorageDriver {
    const driver = this.drivers.get(slug);
    if (!driver) {
      throw new DriverNotRegisteredError(slug);
    }
    return driver;
  }

  private static indexBySlug(drivers: readonly StorageDriver[]): ReadonlyMap<string, StorageDriver> {
    const map = new Map<string, StorageDriver>();
    for (const driver of drivers) {
      if (map.has(driver.slug)) {
        throw new StorageMisconfiguredError(`Duplicate storage driver slug '${driver.slug}'`);
      }
      map.set(driver.slug, driver);
    }
    return map;
  }
}
