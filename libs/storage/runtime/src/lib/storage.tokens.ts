/**
 * Every storage driver registered with the runtime. `StorageService` indexes
 * these by `slug` and routes object-addressed ops (`get`/`head`/`delete`/
 * `signedUrl`) by the object's recorded `driverSlug`, so reads and deletes follow
 * the driver that actually holds the bytes (#100). An unregistered slug is a loud
 * failure, never a wrong-driver op.
 */
export const STORAGE_DRIVERS = Symbol('STORAGE_DRIVERS');

/** Slug new writes (`put`) target. Must resolve to one of `STORAGE_DRIVERS`. */
export const STORAGE_DEFAULT_WRITE_SLUG = Symbol('STORAGE_DEFAULT_WRITE_SLUG');
