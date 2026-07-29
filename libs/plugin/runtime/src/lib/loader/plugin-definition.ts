import type { PluginCategory, PluginScope } from '@bge/database';
import type { PluginManifest } from '@boardgamesempire/plugin-manifest';

/**
 * A successfully loaded plugin as held by `PluginInstanceRegistry`:
 * the factory's product plus the identity needed for category adoption
 * and diagnostics (#79).
 *
 * Host-internal on purpose — the snapshot carries Prisma enums, which the
 * publishable contract lib (`@boardgamesempire/plugin-contract`, home of the
 * author-facing `PluginFactory` this used to sit beside) must not reference.
 */
export interface LoadedPlugin {
  readonly pluginId: string;
  readonly slug: string;
  readonly category: PluginCategory;
  readonly scope: PluginScope;
  readonly manifest: PluginManifest;
  readonly instance: unknown;
}
