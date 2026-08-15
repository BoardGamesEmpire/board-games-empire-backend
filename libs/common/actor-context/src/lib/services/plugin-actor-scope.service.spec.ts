import { SERVER_PLUGIN_UNIT, type Actor, type PluginUnit } from '../types';
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

    scope.run('plugin-1', SERVER_PLUGIN_UNIT, 'unused-when-trigger-exists', () => 42);

    expect(lastInit().actor).toEqual({
      kind: 'plugin',
      pluginId: 'plugin-1',
      unit: { scopeType: 'Server' },
      trigger: user,
    });
  });

  it('falls back to a named system trigger when no actor is in scope (boot-time entry)', () => {
    scope.run('plugin-1', SERVER_PLUGIN_UNIT, 'plugin-boot-load', () => undefined);

    expect(lastInit().actor).toEqual({
      kind: 'plugin',
      pluginId: 'plugin-1',
      unit: { scopeType: 'Server' },
      trigger: { kind: 'system', reason: 'plugin-boot-load' },
    });
  });

  it('carries the household unit coordinates onto the minted actor', () => {
    scope.run('plugin-1', { scopeType: 'Household', householdId: 'hh-1' }, 'reason', () => undefined);

    expect(lastInit().actor).toEqual(
      expect.objectContaining({ unit: { scopeType: 'Household', householdId: 'hh-1' } }),
    );
  });

  it('stores a detached copy of the unit — caller-side mutation cannot retarget the scope', () => {
    const unit = { scopeType: 'Household', householdId: 'hh-1' } as { scopeType: 'Household'; householdId: string };

    scope.run('plugin-1', unit, 'reason', () => undefined);
    unit.householdId = 'hh-other';

    const actor = lastInit().actor as { unit: PluginUnit };
    expect(actor.unit.householdId).toBe('hh-1');
    expect(Object.isFrozen(actor.unit)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['a Server unit carrying a householdId', { scopeType: 'Server', householdId: 'hh-1' }],
    ['a Household unit missing its householdId', { scopeType: 'Household' }],
    ['a Household unit also carrying a userId', { scopeType: 'Household', householdId: 'hh-1', userId: 'u-1' }],
    ['a User unit missing its userId', { scopeType: 'User' }],
    ['an unknown scope type', { scopeType: 'Galaxy' }],
  ])('rejects %s before entering any scope', (_label, unit) => {
    expect(() => scope.run('plugin-1', unit as PluginUnit, 'reason', () => undefined)).toThrow(RangeError);
    expect(internal.runWith).not.toHaveBeenCalled();
  });

  it('preserves an inherited correlation id and source — the plugin step joins the existing causal chain', () => {
    reader.getCorrelationId.mockReturnValue('corr-1');
    reader.getSource.mockReturnValue('http');

    scope.run('plugin-1', SERVER_PLUGIN_UNIT, 'reason', () => undefined);

    expect(lastInit().correlationId).toBe('corr-1');
    expect(lastInit().source).toBe('http');
  });

  it('mints a fresh correlation id and system source when entering from an empty scope', () => {
    scope.run('plugin-1', SERVER_PLUGIN_UNIT, 'reason', () => undefined);

    const init = lastInit();

    expect(init.correlationId).toEqual(expect.any(String));
    expect(init.correlationId.length).toBeGreaterThan(0);
    expect(init.source).toBe('system');
  });

  it('supports nesting: a plugin already in scope becomes the trigger of the inner plugin actor', () => {
    const outer: Actor = {
      kind: 'plugin',
      pluginId: 'outer',
      unit: SERVER_PLUGIN_UNIT,
      trigger: { kind: 'user', userId: 'user-1' },
    };
    reader.getActor.mockReturnValue(outer);

    scope.run('inner', { scopeType: 'User', userId: 'user-1' }, 'reason', () => undefined);

    expect(lastInit().actor).toEqual({
      kind: 'plugin',
      pluginId: 'inner',
      unit: { scopeType: 'User', userId: 'user-1' },
      trigger: outer,
    });
  });

  it('returns the callback result unchanged', () => {
    expect(scope.run('plugin-1', SERVER_PLUGIN_UNIT, 'reason', () => 'result')).toBe('result');
  });
});
