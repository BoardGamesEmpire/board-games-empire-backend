import type { Redis } from 'iovalkey';
import { EventEmitter } from 'node:events';
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

  const client = Object.assign(new EventEmitter(), {
    options: { family: 4 },
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
  });

  return { client: client as unknown as Redis, commands };
}

/**
 * Stands in for a shared client whose connection is gone: every command it is
 * given fails. It is an emitter, as iovalkey's client is, so a test can report
 * a connection error the way the client does, outside any call.
 */
function brokenClient() {
  const lost = async () => {
    throw new Error('Connection is closed.');
  };

  const client = Object.assign(new EventEmitter(), {
    options: { family: 4 },
    set: lost,
    get: lost,
    unlink: lost,
  });

  return client as unknown as Redis;
}

describe('createCacheStore (#449)', () => {
  // Keyv 6 hands the adapter an absolute expiry, which it sends as PXAT.
  const now = new Date('2026-11-26T12:00:00Z').getTime();

  beforeEach(() => jest.useFakeTimers({ now }));
  afterEach(() => jest.useRealTimers());

  it('writes an entry under its physical key with its TTL, and nothing else', async () => {
    const { client, commands } = fakeClient();
    const store = createCacheStore(client, 'api:cache');

    await store.set('bge:user:permissions:u1', { roles: [] }, 60_000);

    expect(commands).toEqual([['set', cacheStoreKey('api:cache', 'bge:user:permissions:u1'), 'PXAT', now + 60_000]]);
  });

  it('reads the entry back from the same key', async () => {
    const { client, commands } = fakeClient();
    const store = createCacheStore(client, 'api:cache');

    await store.set('bge:user:permissions:u1', { roles: [] }, 60_000);

    await expect(store.get('bge:user:permissions:u1')).resolves.toEqual({ roles: [] });
    expect(commands.at(-1)).toEqual(['get', cacheStoreKey('api:cache', 'bge:user:permissions:u1')]);
  });
});

describe('createCacheStore when Redis fails (#640)', () => {
  it('by default reads a failure as a miss and reports a failed write or delete as false', async () => {
    const store = createCacheStore(brokenClient(), 'api:cache');

    await expect(store.get('key')).resolves.toBeUndefined();
    await expect(store.set('key', 'value', 60_000)).resolves.toBe(false);
    await expect(store.delete('key')).resolves.toBe(false);
  });

  it('raises every failed call to the caller when asked to', async () => {
    const store = createCacheStore(brokenClient(), 'api:cache', { throwOnErrors: true });

    await expect(store.get('key')).rejects.toThrow('Connection is closed.');
    await expect(store.set('key', 'value', 60_000)).rejects.toThrow('Connection is closed.');
    await expect(store.delete('key')).rejects.toThrow('Connection is closed.');
  });

  // Keyv 6 throws an error it re-emits when nothing listens, and the adapter
  // re-emits the client's, so a raising store would throw a dropped
  // connection from inside the client, where nothing catches it.
  it("doesn't throw a connection error the client reports outside any call", () => {
    const client = brokenClient();
    createCacheStore(client, 'auth', { throwOnErrors: true });
    createCacheStore(client, 'api:cache');

    expect(() => client.emit('error', new Error('read ECONNRESET'))).not.toThrow();
  });

  it('leaves the shared client one listener for its errors, however many stores it backs', () => {
    const client = brokenClient();
    createCacheStore(client, 'auth', { throwOnErrors: true });
    createCacheStore(client, 'api:cache');
    createCacheStore(client, 'permissions:cache');

    expect(client.listenerCount('error')).toBe(1);
  });
});

describe('cacheStoreKey (#449)', () => {
  it("puts the adapter's prefix and the namespace in front of the key once, and leaves a glob a glob", () => {
    expect(cacheStoreKey('api:cache', 'bge:user:permissions:*')).toBe('namespace:api:cache:bge:user:permissions:*');
  });
});
