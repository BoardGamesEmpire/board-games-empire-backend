import type { Redis } from '@bge/redis';
import Keyv from 'keyv';
import { createAuthStorage, createRedisAuthStorage } from './auth-storage';

/** An in-memory store that raises failures, as the api's Redis-backed one is built to. */
const memoryStore = () => new Keyv({ throwOnErrors: true });

describe('createAuthStorage', () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date('2026-10-20T12:00:00Z') }));
  afterEach(() => jest.useRealTimers());

  it('keeps an entry for as many seconds as better-auth asks, not that many milliseconds (#640)', async () => {
    const storage = createAuthStorage(memoryStore());

    await storage.set('session-token', 'session', 2);

    jest.advanceTimersByTime(1_999);
    await expect(storage.get('session-token')).resolves.toBe('session');

    jest.advanceTimersByTime(2);
    await expect(storage.get('session-token')).resolves.toBeUndefined();
  });

  it('keeps better-auth keys under the auth_ prefix, where the shared cache kept them (#640)', async () => {
    const store = memoryStore();
    const storage = createAuthStorage(store);

    await storage.set('session-token', 'session', 60);

    await expect(store.get('auth_session-token')).resolves.toBe('session');
  });

  it('writes nothing for an entry that has no time left, rather than keeping it forever (#640)', async () => {
    // better-auth computes a TTL from an expiry and floors it, so an entry in
    // its last second arrives with 0. Keyv reads 0 as "no expiry".
    const store = memoryStore();
    const storage = createAuthStorage(store);

    await storage.set('expiring', 'session', 0);
    await storage.set('expired', 'session', -5);

    await expect(store.get('auth_expiring')).resolves.toBeUndefined();
    await expect(store.get('auth_expired')).resolves.toBeUndefined();
  });

  it('deletes an entry (#487)', async () => {
    const storage = createAuthStorage(memoryStore());
    await storage.set('session-token', 'session', 60);

    await storage.delete('session-token');

    await expect(storage.get('session-token')).resolves.toBeUndefined();
  });

  it('raises a failed delete, so a sign-out can tell the session was not revoked (#487)', async () => {
    const store = memoryStore();
    store.on('error', () => undefined);
    const storage = createAuthStorage(store);
    jest.spyOn(store.store as Map<string, unknown>, 'delete').mockImplementation(() => {
      throw new Error('Connection is closed.');
    });

    await expect(storage.delete('session-token')).rejects.toThrow('Connection is closed.');
  });

  it('refuses a store that would pass a failed call off as success (#640)', () => {
    expect(() => createAuthStorage(new Keyv())).toThrow(/throwOnErrors/);
  });
});

describe('createRedisAuthStorage', () => {
  /** Stands in for the shared cache client and records the commands it is given. */
  function recordingClient() {
    const commands: unknown[][] = [];
    const client = {
      options: { family: 4 },
      on: () => client,
      async set(...args: unknown[]) {
        commands.push(['set', ...args]);
        return 'OK';
      },
    };

    return { client: client as unknown as Redis, commands };
  }

  it('writes a session where it always lived in Redis, with a PTTL of its full life (#640)', async () => {
    const { client, commands } = recordingClient();

    await createRedisAuthStorage(client).set('session-token', 'session', 604_800);

    // Seven days, in the milliseconds Redis's PX takes. The value is Keyv's
    // serialized envelope around 'session'.
    expect(commands).toEqual([
      ['set', 'namespace:api:cache:auth_session-token', expect.stringContaining('"session"'), 'PX', 604_800_000],
    ]);
  });
});
