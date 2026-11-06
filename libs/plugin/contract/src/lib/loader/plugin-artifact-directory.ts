declare const pluginArtifactSha256Brand: unique symbol;

/**
 * A plugin artifact's SHA-256 as the server stores and names it: 64 lowercase
 * hex characters (#224). It names the artifact's directory,
 * `<pluginsRoot>/<slug>/<sha256>/`, so nothing else may pass: no traversal,
 * and no second spelling of the same digest.
 *
 * Branded so a value that was never checked cannot reach a path or a column
 * by being a `string` (#1117). `parsePluginArtifactSha256` is the only
 * producer.
 */
export type PluginArtifactSha256 = string & { readonly [pluginArtifactSha256Brand]: true };

export const PLUGIN_ARTIFACT_SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** The branded checksum for a value that is 64 lowercase hex characters, otherwise `null` (#1117). */
export function parsePluginArtifactSha256(value: string): PluginArtifactSha256 | null {
  return PLUGIN_ARTIFACT_SHA256_PATTERN.test(value) ? (value as PluginArtifactSha256) : null;
}

/**
 * Layout contract for a plugin artifact on disk (#59 loader ↔ distribution
 * boundary): the directory `<pluginsRoot>/<slug>/<sha256>/` one artifact is
 * placed in. The loader consumes ONLY this interface; the install ingress
 * (#1094) places directories satisfying it.
 *
 * One type serves an installed artifact and a staged one, because a
 * directory's identity is its checksum: the row column naming it,
 * `installedSha256` or `pendingSha256`, says which of the two it is (#224).
 *
 * Minimal by design: directory root, `manifest.json` at the root, and the
 * package descriptor the entrypoint is resolved from (`exports`-first,
 * `main` fallback — see `entrypoint-resolver.ts`).
 */
export interface PluginArtifactDirectory {
  readonly slug: string;
  /** The artifact's SHA-256 (64 lowercase hex characters): the directory's name and its identity. */
  readonly sha256: PluginArtifactSha256;
  /** Absolute path to the artifact's directory. */
  readonly rootDir: string;
  /** Absolute path to `manifest.json` (always at the root). */
  readonly manifestPath: string;
  /** Absolute path to `package.json` (always at the root). */
  readonly packageJsonPath: string;
}

export const PLUGIN_MANIFEST_FILENAME = 'manifest.json';
export const PLUGIN_PACKAGE_JSON_FILENAME = 'package.json';
