import { BasePluginRegistry } from '@boardgamesempire/plugin-contract';
import { Injectable } from '@nestjs/common';
import type { LoadedPlugin } from './plugin-definition';

/**
 * The loader's slug-keyed registry of every successfully loaded plugin,
 * category-agnostic. Category registries (`DataGatewayRegistry` et al.,
 * #61/#194) adopt instances FROM here with their concrete typing; runtime
 * enable/disable flips both this registry and the category registry in the
 * mutating service (the service is authoritative — the lifecycle listener
 * only records provenance).
 */
@Injectable()
export class PluginInstanceRegistry extends BasePluginRegistry<LoadedPlugin> {
  protected override readonly registryName = 'plugin-instances';
}
