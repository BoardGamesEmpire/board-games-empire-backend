import { describePluginRegistryContract } from './base-plugin-registry.contract.js';
import { BasePluginRegistry } from './base-plugin-registry.js';
import {
  DuplicatePluginRegistrationError,
  PluginDisabledError,
  PluginNotRegisteredError,
  PluginRegistryError,
} from './registry.errors.js';

interface TestDriver {
  readonly seed: number;
  ping(): string;
}

const createTestDriver = (seed: number): TestDriver => ({
  seed,
  ping: () => `pong-${seed}`,
});

class TestPluginRegistry extends BasePluginRegistry<TestDriver> {
  protected override readonly registryName = 'test-driver';
}

describePluginRegistryContract('TestPluginRegistry', {
  createRegistry: () => new TestPluginRegistry(),
  createInstance: createTestDriver,
});

describe('registry error metadata', () => {
  const registry = new TestPluginRegistry();

  const expectRegistryError = (
    call: () => unknown,
    errorType: new (registryName: string, slug: string) => PluginRegistryError,
    slug: string,
  ): void => {
    try {
      call();
    } catch (error) {
      expect(error).toBeInstanceOf(errorType);
      const registryError = error as PluginRegistryError;
      expect(registryError.registryName).toBe('test-driver');
      expect(registryError.slug).toBe(slug);
      expect(registryError.name).toBe(errorType.name);

      return;
    }

    throw new Error(`Expected ${errorType.name} to be thrown`);
  };

  it('carries registryName, slug, and a class-accurate name on every error type', () => {
    registry.register('alpha', createTestDriver(1), { enabled: false });

    expectRegistryError(
      () => registry.register('alpha', createTestDriver(2)),
      DuplicatePluginRegistrationError,
      'alpha',
    );
    expectRegistryError(() => registry.resolve('alpha'), PluginDisabledError, 'alpha');
    expectRegistryError(() => registry.resolve('ghost'), PluginNotRegisteredError, 'ghost');
  });
});
