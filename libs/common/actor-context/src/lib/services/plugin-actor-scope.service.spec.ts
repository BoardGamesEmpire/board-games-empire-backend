import type { Actor } from '../types';
import type { ActorContextInit } from './audit-context-internal.service';
import { AuditContextInternalService } from './audit-context-internal.service';
import { AuditContextService } from './audit-context.service';
import { PluginActorScope } from './plugin-actor-scope.service';

describe('PluginActorScope', () => {
  let internal: jest.Mocked<Pick<AuditContextInternalService, 'runWith'>>;
  let reader: jest.Mocked<Pick<AuditContextService, 'getActor' | 'getCorrelationId' | 'getSource'>>;
  let scope: PluginActorScope;

  const lastInit = (): ActorContextInit => {
    const call = internal.runWith.mock.calls.at(-1);
    if (!call) {
      throw new Error('runWith was not called');
    }

    return call[0];
  };

  beforeEach(() => {
    internal = {
      runWith: jest.fn(<T>(_init: ActorContextInit, fn: () => T): T => fn()),
    } as jest.Mocked<Pick<AuditContextInternalService, 'runWith'>>;
    reader = {
      getActor: jest.fn().mockReturnValue(null),
      getCorrelationId: jest.fn().mockReturnValue(null),
      getSource: jest.fn().mockReturnValue(null),
    } as unknown as jest.Mocked<Pick<AuditContextService, 'getActor' | 'getCorrelationId' | 'getSource'>>;

    scope = new PluginActorScope(
      internal as unknown as AuditContextInternalService,
      reader as unknown as AuditContextService,
    );
  });

  it('mints a plugin actor with the in-scope actor as trigger — a user fanning into a plugin keeps attribution', () => {
    const user: Actor = { kind: 'user', userId: 'user-1' };
    reader.getActor.mockReturnValue(user);

    scope.run('plugin-1', 'unused-when-trigger-exists', () => 42);

    expect(lastInit().actor).toEqual({ kind: 'plugin', pluginId: 'plugin-1', trigger: user });
  });

  it('falls back to a named system trigger when no actor is in scope (boot-time entry)', () => {
    scope.run('plugin-1', 'plugin-boot-load', () => undefined);

    expect(lastInit().actor).toEqual({
      kind: 'plugin',
      pluginId: 'plugin-1',
      trigger: { kind: 'system', reason: 'plugin-boot-load' },
    });
  });

  it('preserves an inherited correlation id and source — the plugin step joins the existing causal chain', () => {
    reader.getCorrelationId.mockReturnValue('corr-1');
    reader.getSource.mockReturnValue('http');

    scope.run('plugin-1', 'reason', () => undefined);

    expect(lastInit().correlationId).toBe('corr-1');
    expect(lastInit().source).toBe('http');
  });

  it('mints a fresh correlation id and system source when entering from an empty scope', () => {
    scope.run('plugin-1', 'reason', () => undefined);

    const init = lastInit();

    expect(init.correlationId).toEqual(expect.any(String));
    expect(init.correlationId.length).toBeGreaterThan(0);
    expect(init.source).toBe('system');
  });

  it('supports nesting: a plugin already in scope becomes the trigger of the inner plugin actor', () => {
    const outer: Actor = {
      kind: 'plugin',
      pluginId: 'outer',
      trigger: { kind: 'user', userId: 'user-1' },
    };
    reader.getActor.mockReturnValue(outer);

    scope.run('inner', 'reason', () => undefined);

    expect(lastInit().actor).toEqual({ kind: 'plugin', pluginId: 'inner', trigger: outer });
  });

  it('returns the callback result unchanged', () => {
    expect(scope.run('plugin-1', 'reason', () => 'result')).toBe('result');
  });
});
