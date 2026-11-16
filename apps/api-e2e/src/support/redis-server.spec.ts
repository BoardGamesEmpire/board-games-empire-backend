import { E2E_REDIS_SERVER_VAR } from './e2e-env';
import type { RedisServerName } from './redis-server';
import { REDIS_SERVERS, selectRedisServer } from './redis-server';

/** Every name a run may give, in the order the refusal lists them. */
const NAMES: readonly RedisServerName[] = [
  'redis',
  'valkey',
  'keydb',
  'dragonfly-undeclared-keys',
  'dragonfly-hashtags',
];

/** The message `selectRedisServer` refuses `value` with, or a failure if it accepts it. */
function refusalOf(value: string): string {
  try {
    selectRedisServer({ [E2E_REDIS_SERVER_VAR]: value });
  } catch (error) {
    return (error as Error).message;
  }

  throw new Error(`selectRedisServer accepted '${value}'`);
}

describe('redis-server (pure selection)', () => {
  it('knows exactly the five Redis-compatible servers a run may name (#462)', () => {
    expect(Object.keys(REDIS_SERVERS).sort()).toEqual([...NAMES].sort());
  });

  describe('selectRedisServer', () => {
    it('runs on stock Redis when the run names none, as every pull request does (#462)', () => {
      expect(selectRedisServer({})).toMatchObject({ name: 'redis', image: 'redis:7-alpine' });
      expect(selectRedisServer({ [E2E_REDIS_SERVER_VAR]: '  ' })).toMatchObject({
        name: 'redis',
        image: 'redis:7-alpine',
      });
    });

    it.each(NAMES)('selects the %s profile by its name (#462)', (name) => {
      const profile = selectRedisServer({ [E2E_REDIS_SERVER_VAR]: name });

      expect(profile).toBe(REDIS_SERVERS[name]);
      expect(profile.name).toBe(name);
    });

    it.each(['dragonfly', 'Valkey'])(
      "refuses '%s' and lists every name, rather than running on Redis and reporting it as the one named (#462)",
      (value) => {
        const message = refusalOf(value);

        expect(message).toContain(E2E_REDIS_SERVER_VAR);
        expect(message).toContain(`'${value}'`);
        expect(message).toContain(NAMES.join(', '));
      },
    );
  });

  describe('REDIS_SERVERS', () => {
    it("starts Dragonfly with the flags each setup tests, and the others with their image's own command (#462)", () => {
      expect(REDIS_SERVERS['dragonfly-hashtags'].command).toEqual(['--cluster_mode=emulated', '--lock_on_hashtags']);
      expect(REDIS_SERVERS['dragonfly-undeclared-keys'].command).toEqual(['--default_lua_flags=allow-undeclared-keys']);
      expect(REDIS_SERVERS.redis.command).toEqual([]);
      expect(REDIS_SERVERS.valkey.command).toEqual([]);
      expect(REDIS_SERVERS.keydb.command).toEqual([]);
    });

    it("lifts the locked-memory limit for Dragonfly alone, as Dragonfly's Docker instructions ask (#462)", () => {
      const unlimited = NAMES.filter((name) => REDIS_SERVERS[name].memlockUnlimited);

      expect(unlimited).toEqual(['dragonfly-undeclared-keys', 'dragonfly-hashtags']);
    });
  });
});
