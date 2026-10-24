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
  beforeEach(() => jest.useFakeTimers({ now: new Date('2026-10-20T12:00:00Z') }));
  afterEach(() => jest.useRealTimers());

  /**
   * Stands in for the shared cache client and records the commands it is
   * given. A GETDEL returns what a SET wrote, as Redis does until the key's
   * PX runs out.
   */
  function recordingClient({
    evalResult = 1,
    evalError,
    getdelError,
  }: { evalResult?: number; evalError?: Error; getdelError?: Error } = {}) {
    const commands: unknown[][] = [];
    const values = new Map<unknown, unknown>();
    const client = {
      options: { family: 4 },
      on: () => client,
      async set(...args: unknown[]) {
        commands.push(['set', ...args]);
        values.set(args[0], args[1]);
        return 'OK';
      },
      async eval(...args: unknown[]) {
        commands.push(['eval', ...args]);
        if (evalError) {
          throw evalError;
        }
        return evalResult;
      },
      async getdel(key: string) {
        commands.push(['getdel', key]);
        if (getdelError) {
          throw getdelError;
        }
        const value = values.get(key) ?? null;
        values.delete(key);
        return value;
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

  it('counts a request in one EVAL on the key get reads, expiring it after the window in milliseconds (#832)', async () => {
    const { client, commands } = recordingClient({ evalResult: 4 });

    await expect(createRedisAuthStorage(client).increment('198.51.100.4/sign-in/email', 10)).resolves.toBe(4);

    expect(commands).toEqual([
      [
        'eval',
        expect.stringMatching(/INCR[\s\S]*PEXPIRE[\s\S]*'NX'/),
        1,
        'namespace:api:cache:auth_198.51.100.4/sign-in/email',
        10_000,
      ],
    ]);
  });

  it('rounds a window that is not whole milliseconds up, as PEXPIRE takes whole ones (#832)', async () => {
    const { client, commands } = recordingClient();

    await createRedisAuthStorage(client).increment('198.51.100.4/sign-in/email', 1.0005);

    expect(commands[0].at(-1)).toBe(1001);
  });

  it('raises a failed count, so the limiter refuses rather than lets the request through (#832)', async () => {
    const { client } = recordingClient({ evalError: new Error('Connection is closed.') });

    await expect(createRedisAuthStorage(client).increment('198.51.100.4/sign-in/email', 10)).rejects.toThrow(
      'Connection is closed.',
    );
  });

  it('takes a value in one GETDEL on the key set wrote, unwrapped as get returns it (#888)', async () => {
    const { client, commands } = recordingClient();
    const storage = createRedisAuthStorage(client);
    await storage.set('verification:abc', '{"value":"u1"}', 60);

    await expect(storage.getAndDelete('verification:abc')).resolves.toBe('{"value":"u1"}');

    expect(commands.slice(1)).toEqual([['getdel', 'namespace:api:cache:auth_verification:abc']]);
  });

  it('reads a value past its expiry as missing, as get does (#888)', async () => {
    // Redis can hand back a key a moment after the expiry Keyv wrote into its
    // envelope, and Keyv's get reads such a key as missing.
    const { client } = recordingClient();
    const storage = createRedisAuthStorage(client);
    await storage.set('verification:abc', '{"value":"u1"}', 60);

    jest.advanceTimersByTime(61_000);

    await expect(storage.getAndDelete('verification:abc')).resolves.toBeUndefined();
  });

  it('reads an absent key as missing (#888)', async () => {
    const { client } = recordingClient();

    await expect(createRedisAuthStorage(client).getAndDelete('verification:abc')).resolves.toBeUndefined();
  });

  it('raises a failed GETDEL, so an outage never reads as a value already used (#888)', async () => {
    const { client } = recordingClient({ getdelError: new Error('Connection is closed.') });

    await expect(createRedisAuthStorage(client).getAndDelete('verification:abc')).rejects.toThrow(
      'Connection is closed.',
    );
  });
});
