import type { RedisOptions } from 'iovalkey';
import { toIoRedisOptions } from './redis-client.factory';
import type { BgeRedisConnectionConfig } from './redis-connection.config';

function makeConfig(overrides: Partial<BgeRedisConnectionConfig> = {}): BgeRedisConnectionConfig {
  return {
    username: '',
    password: '',
    database: 0,
    socket: {
      host: 'localhost',
      port: 6379,
      tls: false,
    },
    ...overrides,
  };
}

describe('toIoRedisOptions', () => {
  describe('basic field mapping', () => {
    it('maps host from socket.host', () => {
      const result = toIoRedisOptions(makeConfig({ socket: { host: 'redis.example.com', port: 6379, tls: false } }));
      expect(result.host).toBe('redis.example.com');
    });

    it('maps port from socket.port', () => {
      const result = toIoRedisOptions(makeConfig({ socket: { host: 'localhost', port: 6380, tls: false } }));
      expect(result.port).toBe(6380);
    });

    it('maps database to db', () => {
      const result = toIoRedisOptions(makeConfig({ database: 2 }));
      expect(result.db).toBe(2);
    });

    it('preserves database when zero', () => {
      const result = toIoRedisOptions(makeConfig({ database: 0 }));
      expect(result.db).toBe(0);
    });
  });

  describe('credentials', () => {
    it('passes username when set', () => {
      const result = toIoRedisOptions(makeConfig({ username: 'bge' }));
      expect(result.username).toBe('bge');
    });

    it('normalises empty username to undefined', () => {
      const result = toIoRedisOptions(makeConfig({ username: '' }));
      expect(result.username).toBeUndefined();
    });

    it('passes password when set', () => {
      const result = toIoRedisOptions(makeConfig({ password: 'secret' }));
      expect(result.password).toBe('secret');
    });

    it('normalises empty password to undefined', () => {
      const result = toIoRedisOptions(makeConfig({ password: '' }));
      expect(result.password).toBeUndefined();
    });
  });

  describe('TLS', () => {
    it('omits tls field when disabled', () => {
      const result = toIoRedisOptions(makeConfig({ socket: { host: 'localhost', port: 6379, tls: false } }));
      expect(result.tls).toBeUndefined();
    });

    it('emits a tls object when enabled', () => {
      const result = toIoRedisOptions(
        makeConfig({
          socket: {
            host: 'redis.example.com',
            port: 6379,
            tls: true,
            rejectUnauthorized: true,
          },
        }),
      );
      expect(result.tls).toEqual({
        ca: undefined,
        key: undefined,
        cert: undefined,
        rejectUnauthorized: true,
      });
    });

    it('passes through ca/key/cert when TLS is enabled', () => {
      const result = toIoRedisOptions(
        makeConfig({
          socket: {
            host: 'redis.example.com',
            port: 6379,
            tls: true,
            ca: 'ca-pem',
            key: 'key-pem',
            cert: 'cert-pem',
            rejectUnauthorized: false,
          },
        }),
      );
      expect(result.tls).toEqual({
        ca: 'ca-pem',
        key: 'key-pem',
        cert: 'cert-pem',
        rejectUnauthorized: false,
      });
    });

    it('normalises empty cert strings to undefined when TLS is enabled', () => {
      const result = toIoRedisOptions(
        makeConfig({
          socket: { host: 'localhost', port: 6379, tls: true, ca: '', key: '', cert: '' },
        }),
      );
      expect(result.tls).toEqual({
        ca: undefined,
        key: undefined,
        cert: undefined,
        rejectUnauthorized: undefined,
      });
    });

    it('ignores cert fields when TLS is disabled', () => {
      const result = toIoRedisOptions(
        makeConfig({
          socket: { host: 'localhost', port: 6379, tls: false, ca: 'ignored' },
        }),
      );
      expect(result.tls).toBeUndefined();
    });
  });

  describe('defaults', () => {
    it('applies a 30s keep-alive', () => {
      const result = toIoRedisOptions(makeConfig());
      expect(result.keepAlive).toBe(30_000);
    });

    it('enables ready check by default', () => {
      const result = toIoRedisOptions(makeConfig());
      expect(result.enableReadyCheck).toBe(true);
    });

    it('sets a connectionName for CLIENT LIST identification', () => {
      const result = toIoRedisOptions(makeConfig());
      expect(result.connectionName).toBe('bge');
    });
  });

  describe('overrides', () => {
    it('lets overrides win over defaults', () => {
      const result = toIoRedisOptions(makeConfig(), { maxRetriesPerRequest: null });
      expect(result.maxRetriesPerRequest).toBeNull();
    });

    it('lets overrides replace keepAlive', () => {
      const result = toIoRedisOptions(makeConfig(), { keepAlive: 60_000 });
      expect(result.keepAlive).toBe(60_000);
    });

    it('lets overrides disable ready check', () => {
      const result = toIoRedisOptions(makeConfig(), { enableReadyCheck: false });
      expect(result.enableReadyCheck).toBe(false);
    });

    it('overrides can introduce options not in the base shape', () => {
      const result = toIoRedisOptions(makeConfig(), { lazyConnect: true } satisfies Partial<RedisOptions>);
      expect(result.lazyConnect).toBe(true);
    });

    it('overrides do not erase host/port', () => {
      const result = toIoRedisOptions(makeConfig({ socket: { host: 'a.example.com', port: 6379, tls: false } }), {
        maxRetriesPerRequest: 1,
      });
      expect(result.host).toBe('a.example.com');
      expect(result.port).toBe(6379);
    });
  });
});
