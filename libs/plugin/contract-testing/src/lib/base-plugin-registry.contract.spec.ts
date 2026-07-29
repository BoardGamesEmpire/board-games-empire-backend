import { BasePluginRegistry } from '@boardgamesempire/plugin-contract';
import { describePluginRegistryContract } from './base-plugin-registry.contract.js';

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

// Exercises the suite against the base class itself. Category registries
// (DataGateway now; StorageDriver when #61 retrofits) run the same suite
// against their concrete classes from their own libs.
describePluginRegistryContract('TestPluginRegistry', {
  createRegistry: () => new TestPluginRegistry(),
  createInstance: createTestDriver,
});
