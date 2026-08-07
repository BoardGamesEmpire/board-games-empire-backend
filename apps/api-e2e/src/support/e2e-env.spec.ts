import {
  decideProvisioning,
  E2E_BASE_URL_VAR,
  E2E_DATABASE_URL_VAR,
  E2E_OWNS_REDIS_VAR,
  E2E_REDIS_URL_VAR,
  parseRedisUrl,
  REDIS_ENV_DATABASES,
  REDIS_ENV_PREFIXES,
  redisEnvOverrides,
  redisOwnershipOverride,
  requireBaseUrl,
  schemaFromDatabaseUrl,
  type RedisEndpoint,
} from './e2e-env';

describe('e2e-env (pure logic)', () => {
  describe('decideProvisioning', () => {
    it('defaults both dependencies to containers', () => {
      expect(decideProvisioning({})).toEqual({
        database: { mode: 'container' },
        redis: { mode: 'container' },
      });
    });

    it('treats blank escape hatches as unset', () => {
      const decision = decideProvisioning({ [E2E_DATABASE_URL_VAR]: '   ', [E2E_REDIS_URL_VAR]: '' });

      expect(decision.database).toEqual({ mode: 'container' });
      expect(decision.redis).toEqual({ mode: 'container' });
    });

    it('routes each dependency independently through its escape hatch', () => {
      const decision = decideProvisioning({
        [E2E_DATABASE_URL_VAR]: 'postgresql://bge:pw@localhost:5433/e2e',
      });

      expect(decision.database).toEqual({ mode: 'external', url: 'postgresql://bge:pw@localhost:5433/e2e' });
      expect(decision.redis).toEqual({ mode: 'container' });
    });
  });

  describe('parseRedisUrl', () => {
    it('parses host, port, and credentials', () => {
      expect(parseRedisUrl('redis://default:s3cret@redis.local:6380')).toEqual<RedisEndpoint>({
        host: 'redis.local',
        port: 6380,
        username: 'default',
        password: 's3cret',
        tls: false,
      });
    });

    it('defaults the port and empty credentials', () => {
      expect(parseRedisUrl('redis://redis.local')).toEqual<RedisEndpoint>({
        host: 'redis.local',
        port: 6379,
        username: '',
        password: '',
        tls: false,
      });
    });

    it('enables TLS for rediss://', () => {
      expect(parseRedisUrl('rediss://redis.local:7000').tls).toBe(true);
    });

    it('rejects non-redis protocols loudly', () => {
      expect(() => parseRedisUrl('http://redis.local:6379')).toThrow(/redis:\/\/ or rediss:\/\//);
    });

    it('percent-decodes credentials', () => {
      // WHATWG URL hands back userinfo STILL ENCODED, so decoding is
      // required, not redundant: '@' must be written '%40' (unescaped it
      // would terminate the userinfo), and forwarding the literal '%40'
      // to Redis would fail AUTH.
      const endpoint = parseRedisUrl('redis://us%3Aer:p%40ss@redis.local:6379');

      expect(endpoint.username).toBe('us:er');
      expect(endpoint.password).toBe('p@ss');
    });

    it('names the variable and the fix when an escape is malformed', () => {
      // A lone '%' makes decodeURIComponent throw 'URI malformed', which
      // identifies neither the input nor the remedy.
      expect(() => parseRedisUrl('redis://u:p%ss@redis.local:6379')).toThrow(/malformed percent-escape/);
      expect(() => parseRedisUrl('redis://u:p%ss@redis.local:6379')).toThrow(new RegExp(E2E_REDIS_URL_VAR));
    });

    it('rejects a database index in the URL', () => {
      // The harness assigns per-connection databases itself; a single URL
      // index would collapse all three logical connections onto one.
      expect(() => parseRedisUrl('redis://redis.local:6379/4')).toThrow(/database index/);
    });
  });

  describe('redisEnvOverrides', () => {
    it('overrides the full connection tuple for every prefix', () => {
      const overrides = redisEnvOverrides({
        host: '127.0.0.1',
        port: 49153,
        username: '',
        password: '',
        tls: false,
      });

      for (const prefix of REDIS_ENV_PREFIXES) {
        expect(overrides[`${prefix}HOST`]).toBe('127.0.0.1');
        expect(overrides[`${prefix}PORT`]).toBe('49153');
        expect(overrides[`${prefix}USERNAME`]).toBe('');
        expect(overrides[`${prefix}PASSWORD`]).toBe('');
        expect(overrides[`${prefix}TLS_ENABLED`]).toBe('false');
      }
    });

    it('pins each connection to its config-default logical database', () => {
      // Without this, a developer's .env (REDIS_BULLMQ_DATABASE=5) reaches
      // the API child while test-side helpers target the default — the two
      // sides silently inspect different logical databases.
      const overrides = redisEnvOverrides({ host: 'h', port: 1, username: '', password: '', tls: false });

      expect(overrides['REDIS_DATABASE']).toBe(String(REDIS_ENV_DATABASES['REDIS_']));
      expect(overrides['REDIS_WEBSOCKET_DATABASE']).toBe(String(REDIS_ENV_DATABASES['REDIS_WEBSOCKET_']));
      expect(overrides['REDIS_BULLMQ_DATABASE']).toBe(String(REDIS_ENV_DATABASES['REDIS_BULLMQ_']));
    });

    it('carries credentials and TLS from an external endpoint', () => {
      const overrides = redisEnvOverrides({
        host: 'redis.internal',
        port: 6379,
        username: 'app',
        password: 'pw',
        tls: true,
      });

      expect(overrides['REDIS_BULLMQ_USERNAME']).toBe('app');
      expect(overrides['REDIS_BULLMQ_PASSWORD']).toBe('pw');
      expect(overrides['REDIS_WEBSOCKET_TLS_ENABLED']).toBe('true');
    });
  });
  describe('redisOwnershipOverride', () => {
    it('claims ownership of a harness-provisioned container', () => {
      expect(redisOwnershipOverride('container')).toEqual({ [E2E_OWNS_REDIS_VAR]: 'true' });
    });

    it('publishes NON-ownership for an external server rather than staying silent', () => {
      // Leaving the variable untouched here was the defect: an inherited
      // 'true' (exported in a shell, left in .env, or set by an earlier
      // container-mode run in the same process) would survive and
      // authorize FLUSHALL against a Redis the harness does not own.
      expect(redisOwnershipOverride('external')).toEqual({ [E2E_OWNS_REDIS_VAR]: 'false' });
    });
  });

  describe('schemaFromDatabaseUrl', () => {
    it('returns the ?schema= search param when present', () => {
      expect(schemaFromDatabaseUrl('postgresql://u:p@localhost:5433/bge?schema=e2e')).toBe('e2e');
    });

    it("defaults to Prisma's public schema", () => {
      expect(schemaFromDatabaseUrl('postgresql://u:p@localhost:5433/bge')).toBe('public');
    });
  });

  describe('requireBaseUrl', () => {
    it('returns the base URL published by globalSetup', () => {
      expect(requireBaseUrl({ [E2E_BASE_URL_VAR]: 'http://127.0.0.1:41234' })).toBe('http://127.0.0.1:41234');
    });

    it('fails loudly when globalSetup never ran', () => {
      expect(() => requireBaseUrl({})).toThrow(new RegExp(E2E_BASE_URL_VAR));
      expect(() => requireBaseUrl({ [E2E_BASE_URL_VAR]: '   ' })).toThrow(new RegExp(E2E_BASE_URL_VAR));
    });
  });
});
