import type { PluginCategory, PluginScope } from '@bge/database';
import type { PluginManifest } from '@boardgamesempire/plugin-manifest';
import type { PluginContext } from '../context/plugin-context';

/**
 * The contract a plugin module satisfies: a default-exported factory taking
 * the host-constructed `PluginContext` and returning the category
 * implementation. Plugins are NOT mounted into the Nest module graph
 * (`LazyModuleLoader` rejected in #59 — mounting untrusted code into host DI
 * undermines the isolation model); the factory + context shape is
 * transport-agnostic by construction, so worker mode (#197) satisfies the
 * same signature over RPC shims.
 *
 * The return type is `unknown` at this layer on purpose: category-specific
 * typing (`GameGatewayDriver` etc.) is applied by the category registries
 * when they adopt loaded instances (#61/#194) — the loader itself is
 * category-agnostic.
 */
export type PluginFactory = (context: PluginContext) => unknown | Promise<unknown>;

/**
 * A successfully loaded plugin as held by `PluginInstanceRegistry`:
 * the factory's product plus the identity needed for category adoption
 * and diagnostics (#79).
 */
export interface LoadedPlugin {
  readonly pluginId: string;
  readonly slug: string;
  readonly category: PluginCategory;
  readonly scope: PluginScope;
  readonly manifest: PluginManifest;
  readonly instance: unknown;
}
