import type { Redis } from '@bge/redis';
import { STEAM_SIGN_IN_LIFETIME_MS, SteamSignInStore } from './steam-sign-in.store';

/** An in-memory stand-in for the four cache commands the store uses. */
function fakeRedis() {
  const values = new Map<string, string>();
  const commands: unknown[][] = [];

  const redis = {
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
      return values.delete(key) ? 1 : 0;
    },
  };

  return { redis: redis as unknown as Redis, values, commands };
}

const pending = { userId: 'user-1', returnTo: 'https://client.example/settings' };

describe('SteamSignInStore', () => {
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
});
