import type { Actor, UserActor } from '@bge/actor-context';
import { UnknownActorKindError } from './context.errors';
import { toPluginActorView } from './plugin-actor-view.projection';

/** A host variant that has gained a field the contract view does not declare. */
interface FutureUserActor extends UserActor {
  readonly sessionToken: string;
  readonly email: string;
}

describe('toPluginActorView', () => {
  it('returns null for an unpopulated CLS scope', () => {
    expect(toPluginActorView(null)).toBeNull();
  });

  describe('per-variant projection', () => {
    // toEqual is exact on own enumerable keys, so a surplus copied field fails.
    it.each<[string, Actor, object]>([
      ['user', { kind: 'user', userId: 'u-1' }, { kind: 'user', userId: 'u-1' }],
      ['anonymous', { kind: 'anonymous', userId: 'u-2' }, { kind: 'anonymous', userId: 'u-2' }],
      [
        'apiKey',
        { kind: 'apiKey', apiKeyId: 'k-1', userId: 'u-3' },
        { kind: 'apiKey', apiKeyId: 'k-1', userId: 'u-3' },
      ],
      ['system', { kind: 'system', reason: 'boot' }, { kind: 'system', reason: 'boot' }],
      [
        'external',
        { kind: 'external', system: 'gateway', identifier: 'bgg' },
        { kind: 'external', system: 'gateway', identifier: 'bgg' },
      ],
    ])('projects the %s variant to exactly its declared fields', (_kind, actor, expected) => {
      expect(toPluginActorView(actor)).toEqual(expected);
    });
  });

  it('drops host fields the contract view does not declare', () => {
    const future: FutureUserActor = {
      kind: 'user',
      userId: 'u-1',
      sessionToken: 'secret-token',
      email: 'someone@example.com',
    };

    const view = toPluginActorView(future);

    expect(view).toEqual({ kind: 'user', userId: 'u-1' });
    expect(Object.keys(view ?? {})).toEqual(['kind', 'userId']);
    expect(JSON.stringify(view)).not.toContain('secret-token');
  });

  it('returns a frozen copy, not the CLS object', () => {
    const actor: Actor = { kind: 'user', userId: 'u-1' };

    const view = toPluginActorView(actor);

    expect(view).not.toBe(actor);
    expect(Object.isFrozen(view)).toBe(true);
  });

  it('cannot be mutated back into the host actor', () => {
    const actor: Actor = { kind: 'user', userId: 'u-1' };
    const view = toPluginActorView(actor) as { userId: string };

    expect(() => {
      view.userId = 'victim';
    }).toThrow(TypeError);
    expect(actor.userId).toBe('u-1');
  });

  describe('plugin chains', () => {
    const trigger: Actor = { kind: 'user', userId: 'u-1' };
    const nested: Actor = { kind: 'plugin', pluginId: 'p-inner', trigger };
    const chain: Actor = { kind: 'plugin', pluginId: 'p-outer', trigger: nested };

    it('projects every level of the trigger chain', () => {
      expect(toPluginActorView(chain)).toEqual({
        kind: 'plugin',
        pluginId: 'p-outer',
        trigger: { kind: 'plugin', pluginId: 'p-inner', trigger: { kind: 'user', userId: 'u-1' } },
      });
    });

    it('freezes nested triggers so no level exposes a host object', () => {
      const view = toPluginActorView(chain) as { trigger: { trigger: unknown } };

      expect(view.trigger).not.toBe(nested);
      expect(Object.isFrozen(view.trigger)).toBe(true);
      expect(view.trigger.trigger).not.toBe(trigger);
      expect(Object.isFrozen(view.trigger.trigger)).toBe(true);
    });
  });

  it('throws UnknownActorKindError for a kind outside the host union', () => {
    const forged = { kind: 'ghost', userId: 'u-1' } as unknown as Actor;

    expect(() => toPluginActorView(forged)).toThrow(UnknownActorKindError);
  });
});
