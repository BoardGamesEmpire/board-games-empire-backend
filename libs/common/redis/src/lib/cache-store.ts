import KeyvValkey from '@keyv/valkey';
import type { Redis } from 'iovalkey';
import type { Keyv as ImportedKeyv } from 'keyv' with { 'resolution-mode': 'import' };
import Keyv from 'keyv';

/**
 * The store a `CacheModule` registration hands cache-manager: Keyv over the
 * shared cache client, under `namespace`. Every Valkey-backed cache builds its
 * store here, so what a store leaves in Redis is decided in one place.
 *
 * - **No index set** (`useSets: false`, the adapter's default since
 *   `@keyv/valkey` 6, stated so the choice stays here). With the set on, the
 *   adapter adds every key it writes to a set for the namespace and removes it
 *   only when the store deletes the key. A key that expires on its TTL, or that
 *   the api's boot flush unlinks, stays a member, so the set grew for as long
 *   as Redis kept it (#449).
 * - **One colon** (`namespaceSeparator: ':'`). Since version 6 the adapter
 *   puts `::` between the namespace and the key by default. The boot flush,
 *   the throttler and better-auth's storage reach keys by
 *   {@link cacheStoreKey}'s `namespace:<namespace>:<key>`, so the store keeps
 *   that layout.
 * - **Failures by listener.** Keyv 6 decides what a failed call does by
 *   whether the store has an `error` listener: with one, the call returns its
 *   fallback (a miss, or `false`); with none, it rejects. A store gets a
 *   listener unless it is asked to raise ({@link CacheStoreOptions}).
 *
 * Nothing bounds a store but its entries' TTLs. Redis evicts nothing,
 * because the job queues share it and BullMQ needs `noeviction`.
 */
export function createCacheStore(client: Redis, namespace: string, options: CacheStoreOptions = {}): Keyv {
  const store = new Keyv({ store: valkeyAdapter(client), namespace });

  if (!options.throwOnErrors) {
    store.on('error', ignoreError);
  }

  return store;
}

/**
 * The adapter over the shared client, without its hold on the client's `error`
 * events.
 *
 * The adapter re-emits each connection error the client reports, and Keyv
 * re-emits it again. A store with no `error` listener throws what it is given,
 * here from inside the client and outside any call, so a dropped connection
 * would crash the process through a store that raises. The adapter's listener
 * gives way to one that drops the error, as the client's connection errors
 * were dropped before Keyv 6, and that keeps the client from printing each one
 * as unhandled.
 */
function valkeyAdapter(client: Redis): KeyvValkey {
  const before = new Set(client.listeners('error'));
  const adapter = new KeyvValkey(client, { useSets: false, namespaceSeparator: ':' });

  for (const listener of client.listeners('error')) {
    if (!before.has(listener)) {
      client.removeListener('error', listener);
    }
  }

  if (!client.listeners('error').includes(ignoreError)) {
    client.on('error', ignoreError);
  }

  return adapter;
}

function ignoreError(): void {
  // Dropped on purpose; see createCacheStore and valkeyAdapter.
}

/**
 * {@link createCacheStore}, typed for `CacheModule` from `@nestjs/cache-manager`.
 *
 * That package is pure ESM, so TypeScript reads keyv's `import` declarations
 * for it, while this CommonJS code gets keyv's `require` ones. Both describe the
 * same class at the same version, but TypeScript treats them as two classes, and
 * their `setMany` return types differ. At runtime the module tells a Keyv store
 * by its shape, not by `instanceof`, so the CommonJS instance works there.
 */
export function createCacheModuleStore(client: Redis, namespace: string): ImportedKeyv {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- keyv's require and import declarations of the one class aren't assignable to each other; see above
  return createCacheStore(client, namespace) as unknown as ImportedKeyv;
}

export interface CacheStoreOptions {
  /**
   * Raise a failed Redis call to the caller. By default the store's `error`
   * listener catches it: a failed read resolves as a miss, and a failed write
   * or delete resolves `false`. A cache can afford that, since the next read
   * misses and loads again. A store that must not lose a write quietly, or
   * pass an outage off as a miss, turns this on, as better-auth's does (#640).
   * Such a store has no `error` listener, and adding one stops it raising.
   */
  readonly throwOnErrors?: boolean;
}

/**
 * The Redis key a {@link createCacheStore} store keeps `key` under, for code
 * that reads or removes keys without the store: the api's boot flush, the
 * e2e suite, and the commands better-auth's storage sends in one step (#832).
 * The prefix is the adapter's. A glob in `key` stays a glob.
 */
export function cacheStoreKey(namespace: string, key: string): string {
  return `namespace:${namespace}:${key}`;
}
