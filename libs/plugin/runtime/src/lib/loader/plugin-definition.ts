import type { PluginCategory, PluginScope } from '@bge/database';
import type { PluginArtifactSha256 } from '@boardgamesempire/plugin-contract';
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
  /** The artifact the plugin was loaded from, as the directory it ran from names it (#1094). */
  readonly sha256: PluginArtifactSha256;
  readonly manifest: PluginManifest;
  readonly instance: unknown;
}
