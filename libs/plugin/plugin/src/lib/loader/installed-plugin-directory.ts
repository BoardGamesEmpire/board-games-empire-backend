/**
 * Layout contract for a plugin on disk (#59 loader ↔ distribution boundary).
 * The loader consumes ONLY this interface; #84's install pipeline populates
 * directories satisfying it, and the bundled branch resolves in-tree
 * directories into the same shape, so the load path is source-agnostic.
 *
 * Minimal by design: directory root, `manifest.json` at the root, and the
 * package descriptor the entrypoint is resolved from (`exports`-first,
 * `main` fallback — see `entrypoint-resolver.ts`).
 */
export interface InstalledPluginDirectory {
  readonly slug: string;
  /** Absolute path to the plugin's root directory. */
  readonly rootDir: string;
  /** Absolute path to `manifest.json` (always at the root). */
  readonly manifestPath: string;
  /** Absolute path to `package.json` (always at the root). */
  readonly packageJsonPath: string;
  /** True when resolved from the in-tree bundled root rather than the install root. */
  readonly bundled: boolean;
}

export const PLUGIN_MANIFEST_FILENAME = 'manifest.json';
export const PLUGIN_PACKAGE_JSON_FILENAME = 'package.json';
