import { E2E_OWNS_REDIS_VAR, E2E_REDIS_FLUSH_OK_VAR } from './e2e-env';
import { mayFlushRedis, redisTlsOptions } from './redis-reset';

describe('redis-reset guard (pure logic)', () => {
  it('permits a flush when the harness provisioned the server', () => {
    expect(mayFlushRedis({ [E2E_OWNS_REDIS_VAR]: 'true' })).toBe(true);
  });

  it('permits a flush when an escape-hatch server is explicitly acknowledged', () => {
    expect(mayFlushRedis({ [E2E_REDIS_FLUSH_OK_VAR]: 'true' })).toBe(true);
  });

  it('refuses when the harness published external ownership', () => {
    // The regression this guards: globalSetup publishes 'false' on the
    // external path, so an inherited 'true' cannot survive into a run
    // pointed at someone's dev Redis.
    expect(mayFlushRedis({ [E2E_OWNS_REDIS_VAR]: 'false' })).toBe(false);
  });

  it('refuses when nothing declared the server expendable', () => {
    expect(mayFlushRedis({})).toBe(false);
  });

  it('treats any non-"true" value as a refusal', () => {
    // Not truthiness: '1', 'yes', and 'TRUE' are all refusals, so a
    // half-remembered spelling fails closed rather than open.
    expect(mayFlushRedis({ [E2E_OWNS_REDIS_VAR]: '1' })).toBe(false);
    expect(mayFlushRedis({ [E2E_OWNS_REDIS_VAR]: 'TRUE' })).toBe(false);
    expect(mayFlushRedis({ [E2E_REDIS_FLUSH_OK_VAR]: 'yes' })).toBe(false);
  });
});

describe('redis-reset TLS options (pure logic)', () => {
  it('offers no TLS when the harness did not publish the flag', () => {
    expect(redisTlsOptions({})).toEqual({});
  });

  it('ignores certificate material while TLS is off', () => {
    // The flag is what redisEnvOverrides publishes; stray certificates left in
    // a developer's shell must not turn a plaintext run into a TLS one.
    expect(redisTlsOptions({ REDIS_TLS_CA: 'ca-pem', REDIS_TLS_ENABLED: 'false' })).toEqual({});
  });

  it('carries the certificate material the API child reads from the same environment', () => {
    // The regression: redisEnvOverrides publishes host/port/credentials and the
    // TLS flag only, but it is Object.assign'ed onto process.env, so these stay
    // standing for the API and were being dropped here — a private CA or mTLS
    // server connected for the API and refused this sweep.
    expect(
      redisTlsOptions({
        REDIS_TLS_ENABLED: 'true',
        REDIS_TLS_CA: 'ca-pem',
        REDIS_TLS_CERT: 'cert-pem',
        REDIS_TLS_KEY: 'key-pem',
      }),
    ).toEqual({
      tls: { ca: 'ca-pem', cert: 'cert-pem', key: 'key-pem', rejectUnauthorized: true },
    });
  });

  it('verifies certificates when nothing says otherwise', () => {
    expect(redisTlsOptions({ REDIS_TLS_ENABLED: 'true' })).toEqual({
      tls: { ca: undefined, cert: undefined, key: undefined, rejectUnauthorized: true },
    });
  });

  it('stops verifying exactly where the app stops', () => {
    // makeRedisConfig reads this through `isTrue` over a default of `true`, so
    // only a true-ish value is a value: 'no' disables verification there, and
    // has to disable it here too. A sweep stricter than the app is the bug.
    expect(redisTlsOptions({ REDIS_TLS_ENABLED: 'true', REDIS_REJECT_UNAUTHORIZED: 'false' })?.tls).toMatchObject({
      rejectUnauthorized: false,
    });
    expect(redisTlsOptions({ REDIS_TLS_ENABLED: 'true', REDIS_REJECT_UNAUTHORIZED: 'no' })?.tls).toMatchObject({
      rejectUnauthorized: false,
    });
    expect(redisTlsOptions({ REDIS_TLS_ENABLED: 'true', REDIS_REJECT_UNAUTHORIZED: 'TRUE' })?.tls).toMatchObject({
      rejectUnauthorized: true,
    });
    expect(redisTlsOptions({ REDIS_TLS_ENABLED: 'true', REDIS_REJECT_UNAUTHORIZED: '' })?.tls).toMatchObject({
      rejectUnauthorized: true,
    });
  });
});
