import {
  type Actor,
  type AnonymousActor,
  type ApiKeyActor,
  type ExternalActor,
  type PluginActor,
  type SystemActor,
  type UserActor,
  actorHasValidPluginUnits,
  actorUserId,
  assertPluginUnit,
  isAnonymousActor,
  isApiKeyActor,
  isExternalActor,
  isPluginActor,
  isPluginUnit,
  isSystemActor,
  isUserActor,
  resolveTrigger,
  SERVER_PLUGIN_UNIT,
} from './index';

describe('Actor type guards', () => {
  const user: UserActor = { kind: 'user', userId: 'user-1' };
  const anonymous: AnonymousActor = { kind: 'anonymous', userId: 'user-2' };
  const apiKey: ApiKeyActor = {
    kind: 'apiKey',
    apiKeyId: 'key-1',
    userId: 'user-3',
  };
  const system: SystemActor = { kind: 'system', reason: 'migration' };
  const external: ExternalActor = {
    kind: 'external',
    system: 'gateway',
    identifier: 'gateway-bgg',
  };
  const plugin: PluginActor = {
    kind: 'plugin',
    pluginId: 'plugin-foo',
    unit: SERVER_PLUGIN_UNIT,
    trigger: user,
  };

  it.each<[string, Actor, (a: Actor) => boolean, boolean]>([
    ['user via isUserActor', user, isUserActor, true],
    ['anonymous via isUserActor', anonymous, isUserActor, false],
    ['anonymous via isAnonymousActor', anonymous, isAnonymousActor, true],
    ['apiKey via isApiKeyActor', apiKey, isApiKeyActor, true],
    ['system via isSystemActor', system, isSystemActor, true],
    ['external via isExternalActor', external, isExternalActor, true],
    ['plugin via isPluginActor', plugin, isPluginActor, true],
    ['user via isPluginActor', user, isPluginActor, false],
  ])('%s returns %s', (_label, actor, guard, expected) => {
    expect(guard(actor)).toBe(expected);
  });
});

describe('isPluginUnit', () => {
  it.each<[string, unknown, boolean]>([
    ['Server with no coordinates', { scopeType: 'Server' }, true],
    ['Household with householdId', { scopeType: 'Household', householdId: 'hh-1' }, true],
    ['User with userId', { scopeType: 'User', userId: 'u-1' }, true],
    ['Server carrying a householdId', { scopeType: 'Server', householdId: 'hh-1' }, false],
    ['Server carrying a userId', { scopeType: 'Server', userId: 'u-1' }, false],
    ['Household missing its householdId', { scopeType: 'Household' }, false],
    ['Household with an empty householdId', { scopeType: 'Household', householdId: '' }, false],
    ['Household also carrying a userId', { scopeType: 'Household', householdId: 'hh-1', userId: 'u-1' }, false],
    ['User missing its userId', { scopeType: 'User' }, false],
    ['User also carrying a householdId', { scopeType: 'User', userId: 'u-1', householdId: 'hh-1' }, false],
    ['unknown scope type', { scopeType: 'Galaxy' }, false],
    ['non-object', 'Server', false],
    ['null', null, false],
  ])('%s -> %s', (_label, value, expected) => {
    expect(isPluginUnit(value)).toBe(expected);
  });

  it('accepts the SERVER_PLUGIN_UNIT constant', () => {
    expect(isPluginUnit(SERVER_PLUGIN_UNIT)).toBe(true);
  });
});

describe('actorHasValidPluginUnits on malformed chains', () => {
  it.each<[string, unknown]>([
    ['a plugin actor with no trigger at all', { kind: 'plugin', pluginId: 'p1', unit: { scopeType: 'Server' } }],
    [
      'a nested plugin actor whose inner trigger is missing',
      {
        kind: 'plugin',
        pluginId: 'outer',
        unit: { scopeType: 'Server' },
        trigger: { kind: 'plugin', pluginId: 'inner', unit: { scopeType: 'Server' } },
      },
    ],
    [
      'a trigger that is not an object',
      { kind: 'plugin', pluginId: 'p1', unit: { scopeType: 'Server' }, trigger: 'system' },
    ],
    [
      'a trigger that is an object but not an actor (no kind)',
      { kind: 'plugin', pluginId: 'p1', unit: { scopeType: 'Server' }, trigger: { foo: 'bar' } },
    ],
    [
      'a trigger with an unrecognized kind',
      { kind: 'plugin', pluginId: 'p1', unit: { scopeType: 'Server' }, trigger: { kind: 'galaxy', reason: 't' } },
    ],
    ['a non-actor object at the top level', { foo: 'bar' }],
    ['a null actor', null],
  ])('returns false (never throws) for %s', (_label, actor) => {
    expect(actorHasValidPluginUnits(actor as never)).toBe(false);
  });

  it('accepts a chain terminating in a real non-plugin actor', () => {
    const actor: PluginActor = {
      kind: 'plugin',
      pluginId: 'p1',
      unit: SERVER_PLUGIN_UNIT,
      trigger: { kind: 'system', reason: 'boot' },
    };

    expect(actorHasValidPluginUnits(actor)).toBe(true);
  });
});

describe('assertPluginUnit', () => {
  it('passes a valid unit through silently', () => {
    expect(() => assertPluginUnit({ scopeType: 'Household', householdId: 'hh-1' }, 'Spec ingress')).not.toThrow();
  });

  it('throws a RangeError naming the caller context and the offending unit', () => {
    expect(() => assertPluginUnit({ scopeType: 'Server', householdId: 'hh-1' }, "Spec ingress for 'plg_1'")).toThrow(
      new RangeError(
        `Spec ingress for 'plg_1' received an invalid plugin unit {"scopeType":"Server","householdId":"hh-1"}: ` +
          'expected Server (no coordinates), Household (householdId only), or User (userId only)',
      ),
    );
  });
});

describe('resolveTrigger', () => {
  it('returns the actor unchanged when not a plugin', () => {
    const user: UserActor = { kind: 'user', userId: 'user-1' };
    expect(resolveTrigger(user)).toBe(user);
  });

  it('unwraps a single plugin layer', () => {
    const user: UserActor = { kind: 'user', userId: 'user-1' };
    const plugin: PluginActor = {
      kind: 'plugin',
      pluginId: 'plugin-1',
      unit: SERVER_PLUGIN_UNIT,
      trigger: user,
    };
    expect(resolveTrigger(plugin)).toEqual(user);
  });

  it('unwraps nested plugin layers', () => {
    const user: UserActor = { kind: 'user', userId: 'user-1' };
    const inner: PluginActor = {
      kind: 'plugin',
      pluginId: 'plugin-inner',
      unit: { scopeType: 'Household', householdId: 'hh-1' },
      trigger: user,
    };
    const outer: PluginActor = {
      kind: 'plugin',
      pluginId: 'plugin-outer',
      unit: SERVER_PLUGIN_UNIT,
      trigger: inner,
    };
    expect(resolveTrigger(outer)).toEqual(user);
  });
});

describe('actorUserId', () => {
  it.each<[string, Actor, string | null]>([
    ['user', { kind: 'user', userId: 'u1' }, 'u1'],
    ['anonymous', { kind: 'anonymous', userId: 'u2' }, 'u2'],
    ['apiKey', { kind: 'apiKey', apiKeyId: 'k1', userId: 'u3' }, 'u3'],
    ['system', { kind: 'system', reason: 'cron' }, null],
    ['external', { kind: 'external', system: 'gateway', identifier: 'g1' }, null],
    [
      'plugin wrapping user',
      {
        kind: 'plugin',
        pluginId: 'p1',
        unit: SERVER_PLUGIN_UNIT,
        trigger: { kind: 'user', userId: 'u4' },
      },
      'u4',
    ],
    [
      'plugin wrapping system',
      {
        kind: 'plugin',
        pluginId: 'p2',
        unit: SERVER_PLUGIN_UNIT,
        trigger: { kind: 'system', reason: 'auto' },
      },
      null,
    ],
  ])('returns %s -> %s', (_label, actor, expected) => {
    expect(actorUserId(actor)).toBe(expected);
  });
});
