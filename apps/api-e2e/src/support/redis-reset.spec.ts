import { E2E_OWNS_REDIS_VAR, E2E_REDIS_FLUSH_OK_VAR } from './e2e-env';
import { mayFlushRedis } from './redis-reset';

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
