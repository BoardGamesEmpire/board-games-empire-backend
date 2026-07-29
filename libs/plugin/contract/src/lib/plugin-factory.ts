import type { PluginContext } from './context/plugin-context.js';

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
