import KeyvValkey from '@keyv/valkey';
import type { Redis } from 'iovalkey';
import Keyv from 'keyv';

/**
 * The store a `CacheModule` registration hands cache-manager: Keyv over the
 * shared cache client, under `namespace`. Every Valkey-backed cache builds its
 * store here, so what a store leaves in Redis is decided in one place.
 *
 * - **No index set** (`useRedisSets: false`). By default the adapter adds
 *   every key it writes to a `namespace:<namespace>` set and removes it only
 *   when the store deletes the key. A key that expires on its TTL, or that the
 *   api's boot flush unlinks, stays a member, so the set grew for as long as
 *   Redis kept it (#449). The cost falls on two calls nothing here makes: the
 *   adapter's `clear()` finds the keys with `KEYS`, which blocks Redis, and
 *   matches any namespace that starts with this one; and Keyv's iterator
 *   scans for the namespace without the adapter's prefix, so it finds nothing.
 * - **One prefix** (`useKeyPrefix: false`). With the set off, the adapter
 *   prefixes each key itself ({@link cacheStoreKey}), and Keyv's own prefix
 *   would repeat the namespace.
 *
 * Nothing bounds a store but its entries' TTLs. Redis evicts nothing,
 * because the job queues share it and BullMQ needs `noeviction`.
 */
export function createCacheStore(client: Redis, namespace: string): Keyv {
  return new Keyv({
    store: new KeyvValkey(client, { useRedisSets: false }),
    namespace,
    useKeyPrefix: false,
  });
}

/**
 * The Redis key a {@link createCacheStore} store keeps `key` under, for code
 * that reads or removes keys without the store: the api's boot flush and the
 * e2e suite. The prefix is the adapter's. A glob in `key` stays a glob.
 */
export function cacheStoreKey(namespace: string, key: string): string {
  return `namespace:${namespace}:${key}`;
}
