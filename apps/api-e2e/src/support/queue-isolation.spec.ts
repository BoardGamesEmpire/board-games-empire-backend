import { E2E_OWNS_REDIS_VAR, E2E_REDIS_FLUSH_OK_VAR } from './e2e-env';
import { openIsolatedQueue } from './queue-isolation';

/**
 * The refusal half of `isolateQueue`, reached through the function its
 * `beforeAll` calls. None of these environments names a Redis host, so a guard
 * that let the call through would fail differently: on the missing
 * `REDIS_BULLMQ_*` connection details rather than on the ownership check. The
 * message is therefore what proves the guard ran first, before any connection
 * existed to obliterate with.
 */
describe('openIsolatedQueue', () => {
  it('refuses a Redis the harness published as not its own', () => {
    expect(() => openIsolatedQueue('feedback-delivery', { [E2E_OWNS_REDIS_VAR]: 'false' })).toThrow(
      /Refusing to obliterate the 'feedback-delivery' queue.*BGE_E2E_REDIS_FLUSH_OK=true/s,
    );
  });

  it('refuses when globalSetup never published ownership at all', () => {
    expect(() => openIsolatedQueue('feedback-delivery', {})).toThrow(/Refusing to obliterate/);
  });

  it('lets an owned server through to the connection', () => {
    expect(() => openIsolatedQueue('feedback-delivery', { [E2E_OWNS_REDIS_VAR]: 'true' })).toThrow(/REDIS_BULLMQ_HOST/);
  });

  it('lets an acknowledged escape-hatch server through to the connection', () => {
    expect(() => openIsolatedQueue('feedback-delivery', { [E2E_REDIS_FLUSH_OK_VAR]: 'true' })).toThrow(
      /REDIS_BULLMQ_HOST/,
    );
  });
});
