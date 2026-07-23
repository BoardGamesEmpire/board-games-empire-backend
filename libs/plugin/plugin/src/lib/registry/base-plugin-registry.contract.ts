import { beforeEach, describe, expect, it } from '@jest/globals';
import { BasePluginRegistry } from './base-plugin-registry.js';
import { DuplicatePluginRegistrationError, PluginDisabledError, PluginNotRegisteredError } from './registry.errors.js';

export interface PluginRegistryContractOptions<TInstance> {
  /** Fresh, empty registry per test. */
  readonly createRegistry: () => BasePluginRegistry<TInstance>;
  /** Distinct instances per seed so identity assertions are meaningful. */
  readonly createInstance: (seed: number) => TInstance;
}

/**
 * Behavioral contract every `BasePluginRegistry` subclass must satisfy.
 * Category registries (DataGateway now; StorageDriver when #61 retrofits)
 * run this suite against their concrete class so subclass overrides cannot
 * silently weaken the fail-loud semantics:
 *
 * ```ts
 * describePluginRegistryContract('DataGatewayRegistry', {
 *   createRegistry: () => new DataGatewayRegistry(),
 *   createInstance: (seed) => buildFakeGatewayDriver(seed),
 * });
 * ```
 */
export const describePluginRegistryContract = <TInstance>(
  name: string,
  options: PluginRegistryContractOptions<TInstance>,
): void => {
  describe(`${name} (BasePluginRegistry contract)`, () => {
    let registry: BasePluginRegistry<TInstance>;

    beforeEach(() => {
      registry = options.createRegistry();
    });

    describe('register', () => {
      it('registers enabled by default', () => {
        registry.register('alpha', options.createInstance(1));

        expect(registry.has('alpha')).toBe(true);
        expect(registry.isEnabled('alpha')).toBe(true);
        expect(registry.size).toBe(1);
      });

      it('honors an explicit disabled registration', () => {
        registry.register('alpha', options.createInstance(1), { enabled: false });

        expect(registry.isEnabled('alpha')).toBe(false);
      });

      it('throws DuplicatePluginRegistrationError on a second registration of the same slug', () => {
        registry.register('alpha', options.createInstance(1));

        expect(() => registry.register('alpha', options.createInstance(2))).toThrow(DuplicatePluginRegistrationError);
      });
    });

    describe('unregister', () => {
      it('removes the entry', () => {
        registry.register('alpha', options.createInstance(1));
        registry.unregister('alpha');

        expect(registry.has('alpha')).toBe(false);
        expect(registry.size).toBe(0);
      });

      it('throws PluginNotRegisteredError for an unknown slug', () => {
        expect(() => registry.unregister('ghost')).toThrow(PluginNotRegisteredError);
      });
    });

    describe('get (introspection)', () => {
      it('returns the registered instance', () => {
        const instance = options.createInstance(1);
        registry.register('alpha', instance);

        expect(registry.get('alpha')).toBe(instance);
      });

      it('returns undefined for an unknown slug', () => {
        expect(registry.get('ghost')).toBeUndefined();
      });

      it('still returns a DISABLED instance — introspection is not the serving path', () => {
        const instance = options.createInstance(1);
        registry.register('alpha', instance, { enabled: false });

        expect(registry.get('alpha')).toBe(instance);
      });
    });

    describe('resolve (serving path)', () => {
      it('returns an enabled instance', () => {
        const instance = options.createInstance(1);
        registry.register('alpha', instance);

        expect(registry.resolve('alpha')).toBe(instance);
      });

      it('throws PluginNotRegisteredError for an unknown slug', () => {
        expect(() => registry.resolve('ghost')).toThrow(PluginNotRegisteredError);
      });

      it('throws PluginDisabledError for a disabled slug — disabled plugins are not served', () => {
        registry.register('alpha', options.createInstance(1), { enabled: false });

        expect(() => registry.resolve('alpha')).toThrow(PluginDisabledError);
      });
    });

    describe('enablement', () => {
      it('setEnabled flips serving behavior both ways', () => {
        const instance = options.createInstance(1);
        registry.register('alpha', instance);

        registry.setEnabled('alpha', false);
        expect(() => registry.resolve('alpha')).toThrow(PluginDisabledError);

        registry.setEnabled('alpha', true);
        expect(registry.resolve('alpha')).toBe(instance);
      });

      it.each(['setEnabled', 'isEnabled'] as const)(
        '%s throws PluginNotRegisteredError for an unknown slug',
        (method) => {
          const call =
            method === 'setEnabled' ? () => registry.setEnabled('ghost', true) : () => registry.isEnabled('ghost');

          expect(call).toThrow(PluginNotRegisteredError);
        },
      );
    });

    describe('list', () => {
      beforeEach(() => {
        registry.register('alpha', options.createInstance(1));
        registry.register('beta', options.createInstance(2), { enabled: false });
        registry.register('gamma', options.createInstance(3));
      });

      it('returns every entry in insertion order with enablement flags', () => {
        expect(registry.list().map((entry) => [entry.slug, entry.enabled])).toEqual([
          ['alpha', true],
          ['beta', false],
          ['gamma', true],
        ]);
      });

      it('filters by enabled: true', () => {
        expect(registry.list({ enabled: true }).map((entry) => entry.slug)).toEqual(['alpha', 'gamma']);
      });

      it('filters by enabled: false', () => {
        expect(registry.list({ enabled: false }).map((entry) => entry.slug)).toEqual(['beta']);
      });
    });

    describe('clear', () => {
      it('drops every entry', () => {
        registry.register('alpha', options.createInstance(1));
        registry.clear();

        expect(registry.size).toBe(0);
        expect(registry.has('alpha')).toBe(false);
      });
    });
  });
};
