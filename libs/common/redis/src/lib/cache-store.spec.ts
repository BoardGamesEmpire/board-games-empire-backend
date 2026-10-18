import type { Redis } from 'iovalkey';
import { cacheStoreKey, createCacheStore } from './cache-store';

/**
 * Stands in for the shared client: records each command and keeps the strings
 * it is given. The adapter takes an object whose `options` carry a `family`
 * for an open client, as iovalkey's do, and opens a connection of its own for
 * anything else. With its index on, the adapter writes in a MULTI that adds
 * the key to a set, so the fake records those commands too: a SADD in the
 * list is the index coming back.
 */
function fakeClient() {
  const commands: unknown[][] = [];
  const strings = new Map<string, string>();
  const set = (key: string, value: string, ...args: unknown[]) => {
    commands.push(['set', key, ...args]);
    strings.set(key, value);
  };
  const client = {
    options: { family: 4 },
    on: () => client,
    async set(key: string, value: string, ...args: unknown[]) {
      set(key, value, ...args);
      return 'OK';
    },
    async get(key: string) {
      commands.push(['get', key]);
      return strings.get(key) ?? null;
    },
    multi() {
      const transaction = {
        set: (key: string, value: string, ...args: unknown[]) => (set(key, value, ...args), transaction),
        sadd: (key: string, member: string) => (commands.push(['sadd', key, member]), transaction),
        exec: async () => [],
      };
      return transaction;
    },
  };

  return { client: client as unknown as Redis, commands };
}

describe('createCacheStore (#449)', () => {
  it('writes an entry under its physical key with its TTL, and nothing else', async () => {
    const { client, commands } = fakeClient();
    const store = createCacheStore(client, 'api:cache');

    await store.set('bge:user:permissions:u1', { roles: [] }, 60_000);

    expect(commands).toEqual([['set', cacheStoreKey('api:cache', 'bge:user:permissions:u1'), 'PX', 60_000]]);
  });

  it('reads the entry back from the same key', async () => {
    const { client, commands } = fakeClient();
    const store = createCacheStore(client, 'api:cache');

    await store.set('bge:user:permissions:u1', { roles: [] }, 60_000);

    await expect(store.get('bge:user:permissions:u1')).resolves.toEqual({ roles: [] });
    expect(commands.at(-1)).toEqual(['get', cacheStoreKey('api:cache', 'bge:user:permissions:u1')]);
  });
});

describe('cacheStoreKey (#449)', () => {
  it("puts the adapter's prefix and the namespace in front of the key once, and leaves a glob a glob", () => {
    expect(cacheStoreKey('api:cache', 'bge:user:permissions:*')).toBe('namespace:api:cache:bge:user:permissions:*');
  });
});
