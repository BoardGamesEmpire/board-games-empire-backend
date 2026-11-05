/**
 * Layout contract for a plugin artifact on disk (#59 loader ↔ distribution
 * boundary): the directory `<pluginsRoot>/<slug>/<sha256>/` one artifact is
 * placed in. The loader consumes ONLY this interface; the install ingress
 * (planned, #1094) is to place directories satisfying it.
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
  readonly sha256: string;
  /** Absolute path to the artifact's directory. */
  readonly rootDir: string;
  /** Absolute path to `manifest.json` (always at the root). */
  readonly manifestPath: string;
  /** Absolute path to `package.json` (always at the root). */
  readonly packageJsonPath: string;
}

export const PLUGIN_MANIFEST_FILENAME = 'manifest.json';
export const PLUGIN_PACKAGE_JSON_FILENAME = 'package.json';
