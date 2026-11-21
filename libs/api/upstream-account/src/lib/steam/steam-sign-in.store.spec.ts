import type { Redis } from '@bge/redis';
import { STEAM_SIGN_IN_LIFETIME_MS, SteamSignInStore } from './steam-sign-in.store';

/** An in-memory stand-in for the cache commands the store uses. */
function fakeRedis() {
  const values = new Map<string, string>();
  const commands: unknown[][] = [];
  const failures = { del: 0 };

  const redis = {
    async get(key: string) {
      commands.push(['get', key]);
      return values.get(key) ?? null;
    },
    async set(key: string, value: string, ...options: unknown[]) {
      commands.push(['set', key, value, ...options]);
      const previous = values.get(key) ?? null;
      values.set(key, value);
      return options.includes('GET') ? previous : 'OK';
    },
    async getdel(key: string) {
      commands.push(['getdel', key]);
      const value = values.get(key) ?? null;
      values.delete(key);
      return value;
    },
    async del(key: string) {
      commands.push(['del', key]);
      if (failures.del > 0) {
        failures.del -= 1;
        throw new Error('Connection is closed.');
      }

      return values.delete(key) ? 1 : 0;
    },
  };

  return { redis: redis as unknown as Redis, values, commands, failures };
}

const pending = { userId: 'user-1', returnTo: 'https://client.example/settings' };

describe('SteamSignInStore (#935)', () => {
  it('keeps a pending sign-in for 30 minutes (#935)', async () => {
    const { redis, commands } = fakeRedis();
    const store = new SteamSignInStore(redis);

    const { state, expiresAt } = await store.start(pending);

    expect(state).toMatch(/^[a-zA-Z0-9_-]{32}$/);
    expect(STEAM_SIGN_IN_LIFETIME_MS).toBe(1_800_000);
    expect(commands[0]).toEqual([
      'set',
      `bge:upstream-link:steam:state:${state}`,
      expect.stringContaining('"userId":"user-1"'),
      'PX',
      1_800_000,
    ]);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(1_799_000);
  });

  it('takes a pending sign-in once (#935)', async () => {
    const store = new SteamSignInStore(fakeRedis().redis);
    const { state } = await store.start(pending);

    await expect(store.take(state)).resolves.toEqual({ ...pending, createdAt: expect.any(String) });
    await expect(store.take(state)).resolves.toBeNull();
  });

  it("replaces the user's earlier pending sign-in when they start again (#935)", async () => {
    const store = new SteamSignInStore(fakeRedis().redis);
    const first = await store.start(pending);
    const second = await store.start(pending);

    await expect(store.take(first.state)).resolves.toBeNull();
    await expect(store.take(second.state)).resolves.toMatchObject(pending);
  });

  // Deleting the displaced state is a separate command from the pointer swap,
  // so it can fail, or lose a race to the earlier sign-in's return. The
  // pointer decides, so a displaced state stays unusable either way (#935).
  it('refuses a displaced state whose delete failed, also after a retry succeeds (#935)', async () => {
    const { redis, values, failures } = fakeRedis();
    const store = new SteamSignInStore(redis);
    const first = await store.start(pending);

    failures.del = 1;
    await expect(store.start(pending)).rejects.toThrow('Connection is closed.');
    expect(values.has(`bge:upstream-link:steam:state:${first.state}`)).toBe(true);

    const retry = await store.start(pending);

    await expect(store.take(first.state)).resolves.toBeNull();
    await expect(store.take(retry.state)).resolves.toMatchObject(pending);
  });

  it("refuses a stored state its user's pointer does not name (#935)", async () => {
    const { redis, values } = fakeRedis();
    const store = new SteamSignInStore(redis);
    const state = 'a'.repeat(32);
    values.set(
      `bge:upstream-link:steam:state:${state}`,
      JSON.stringify({ ...pending, createdAt: new Date().toISOString() }),
    );

    await expect(store.take(state)).resolves.toBeNull();
    expect(values.has(`bge:upstream-link:steam:state:${state}`)).toBe(false);
  });

  it("leaves another user's pending sign-in alone (#935)", async () => {
    const store = new SteamSignInStore(fakeRedis().redis);
    const other = await store.start({ ...pending, userId: 'user-2' });

    await store.start(pending);

    await expect(store.take(other.state)).resolves.toMatchObject({ userId: 'user-2' });
  });

  it('keeps only one state takeable when two starts for a user overlap (#935)', async () => {
    const { redis, values } = fakeRedis();
    const store = new SteamSignInStore(redis);

    const [a, b] = await Promise.all([store.start(pending), store.start(pending)]);
    const named = values.get(`bge:upstream-link:steam:user:${pending.userId}`);
    const taken = await Promise.all([store.take(a.state), store.take(b.state)]);

    expect(taken.filter((entry) => entry !== null)).toHaveLength(1);
    // The survivor is the state the user's pointer names, the last swap's.
    expect([a.state, b.state]).toContain(named);
    expect(taken[named === a.state ? 0 : 1]).not.toBeNull();
  });

  it('reads a malformed state or record as nothing, without a Redis call for the state (#935)', async () => {
    const { redis, values, commands } = fakeRedis();
    const store = new SteamSignInStore(redis);

    await expect(store.take('short')).resolves.toBeNull();
    await expect(store.take('x'.repeat(31) + '!')).resolves.toBeNull();
    await expect(store.take('a'.repeat(33))).resolves.toBeNull();
    expect(commands).toEqual([]);

    const state = 'a'.repeat(32);
    // The user's pointer names the state, so only the record itself can be
    // what a take refuses: without it, any record reads as nothing (#935).
    values.set(`bge:upstream-link:steam:user:${pending.userId}`, state);
    values.set(`bge:upstream-link:steam:state:${state}`, 'not json');
    await expect(store.take(state)).resolves.toBeNull();

    const malformed: unknown[] = [
      { userId: 1 },
      { userId: 'user-1', returnTo: 5, createdAt: new Date().toISOString() },
      { userId: 'user-1', returnTo: pending.returnTo },
      null,
      [],
      'x',
    ];
    for (const record of malformed) {
      values.set(`bge:upstream-link:steam:state:${state}`, JSON.stringify(record));
      await expect(store.take(state)).resolves.toBeNull();
    }
  });

  // A record is data from outside the process, parsed through its schema
  // (#1322): the browser is redirected to `returnTo`, so a record whose
  // address is not an absolute http or https one is read as nothing (#935).
  it.each([
    ['a relative return address', { returnTo: '/settings' }],
    ['a javascript: return address', { returnTo: 'javascript:alert(1)' }],
    ["an app's own scheme", { returnTo: 'bge://upstream-accounts' }],
    ['an empty user id', { userId: '' }],
    ['a start time that is not a timestamp', { createdAt: 'yesterday' }],
  ])('reads a record with %s as nothing (#935)', async (_, change) => {
    const { redis, values } = fakeRedis();
    const store = new SteamSignInStore(redis);
    const state = 'a'.repeat(32);
    const record = { ...pending, createdAt: new Date().toISOString(), ...change };
    // The record's user's pointer names the state, so only the record's
    // schema can be what a take refuses (#935).
    values.set(`bge:upstream-link:steam:user:${record.userId}`, state);
    values.set(`bge:upstream-link:steam:state:${state}`, JSON.stringify(record));

    await expect(store.take(state)).resolves.toBeNull();
  });

  // zod's `httpUrl()` wants a dotted hostname with a letter TLD, which a
  // self-hoster's own client address often lacks (#935).
  it.each([
    'http://localhost:4200/settings',
    'http://127.0.0.1:4200/settings',
    'http://192.168.1.10:8080/settings',
    'http://nas:8080/settings',
    'http://[::1]:4200/settings',
  ])('stores and takes back a return address of %s (#935)', async (returnTo) => {
    const store = new SteamSignInStore(fakeRedis().redis);
    const { state } = await store.start({ ...pending, returnTo });

    await expect(store.take(state)).resolves.toMatchObject({ returnTo });
  });
});
