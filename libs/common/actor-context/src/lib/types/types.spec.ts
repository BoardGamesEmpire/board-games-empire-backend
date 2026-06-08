import {
  type Actor,
  type AnonymousActor,
  type ApiKeyActor,
  type ExternalActor,
  type PluginActor,
  type SystemActor,
  type UserActor,
  actorUserId,
  isAnonymousActor,
  isApiKeyActor,
  isExternalActor,
  isPluginActor,
  isSystemActor,
  isUserActor,
  resolveTrigger,
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
      trigger: user,
    };
    expect(resolveTrigger(plugin)).toEqual(user);
  });

  it('unwraps nested plugin layers', () => {
    const user: UserActor = { kind: 'user', userId: 'user-1' };
    const inner: PluginActor = {
      kind: 'plugin',
      pluginId: 'plugin-inner',
      trigger: user,
    };
    const outer: PluginActor = {
      kind: 'plugin',
      pluginId: 'plugin-outer',
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
        trigger: { kind: 'user', userId: 'u4' },
      },
      'u4',
    ],
    [
      'plugin wrapping system',
      {
        kind: 'plugin',
        pluginId: 'p2',
        trigger: { kind: 'system', reason: 'auto' },
      },
      null,
    ],
  ])('returns %s -> %s', (_label, actor, expected) => {
    expect(actorUserId(actor)).toBe(expected);
  });
});
