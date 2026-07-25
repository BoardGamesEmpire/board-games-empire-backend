import { isAbsolute, relative, resolve, sep } from 'node:path';
import { PluginEntrypointError } from './loader.errors';
import { isContained, realpathOrNull } from './path-containment';

/**
 * The subset of `package.json` the loader reads. Everything else in the
 * descriptor is ignored — npm-audit and integrity concerns are the install
 * pipeline's job (#84), not the boot path's.
 */
export interface PluginPackageDescriptor {
  readonly name?: string;
  readonly main?: string;
  readonly exports?: PackageExportsField;
}

/**
 * Recursive shape of the `exports` field per the Node.js packages spec.
 * Arrays are alternative fallbacks; objects are either subpath maps (keys
 * starting with '.') or condition maps.
 */
export type PackageExportsField =
  | string
  | ReadonlyArray<PackageExportsField>
  | { readonly [key: string]: PackageExportsField | null };

/**
 * Conditions honored when walking a condition map, in priority order. The
 * host imports plugins as ESM (`import()`), so `import` wins; `node` and
 * `default` are the standard fallbacks. `require` is intentionally absent —
 * the host never CJS-requires a plugin.
 */
const HONORED_CONDITIONS = ['import', 'node', 'default'] as const;

/**
 * Resolves a plugin's entrypoint to an absolute path inside its directory:
 * `exports`-first (root '.' subpath only — plugins expose exactly one
 * entrypoint to the host), `main` fallback.
 *
 * Containment is enforced here rather than trusted from the descriptor: a
 * `package.json` is attacker-influenced content in the threat model (#59
 * static analysis is defense-in-depth), so an entrypoint resolving outside
 * the plugin root — `../../etc/anything`, absolute paths — is a hard
 * `PluginEntrypointError`, never a silent clamp.
 */
export function resolvePluginEntrypoint(slug: string, descriptor: PluginPackageDescriptor, rootDir: string): string {
  const specifier = pickSpecifier(slug, descriptor);

  if (isAbsolute(specifier)) {
    throw new PluginEntrypointError(slug, `entrypoint must be package-relative, got absolute path '${specifier}'`);
  }

  const resolved = resolve(rootDir, specifier);
  const relativeToRoot = relative(resolve(rootDir), resolved);

  if (relativeToRoot === '' || relativeToRoot === '..' || relativeToRoot.startsWith(`..${sep}`)) {
    throw new PluginEntrypointError(slug, `entrypoint '${specifier}' escapes the plugin directory`);
  }

  return resolved;
}

function pickSpecifier(slug: string, descriptor: PluginPackageDescriptor): string {
  if (descriptor.exports !== undefined) {
    const fromExports = resolveExports(descriptor.exports);

    if (fromExports === null) {
      throw new PluginEntrypointError(
        slug,
        `package 'exports' declares no root ('.') entrypoint resolvable under conditions [${HONORED_CONDITIONS.join(', ')}]`,
      );
    }

    return fromExports;
  }

  if (typeof descriptor.main === 'string' && descriptor.main.length > 0) {
    return descriptor.main;
  }

  throw new PluginEntrypointError(slug, `package.json declares neither 'exports' nor 'main'`);
}

function resolveExports(field: PackageExportsField | null): string | null {
  if (field === null) {
    return null;
  }

  if (typeof field === 'string') {
    return field;
  }

  if (Array.isArray(field)) {
    for (const alternative of field) {
      const resolved = resolveExports(alternative);
      if (resolved !== null) {
        return resolved;
      }
    }

    return null;
  }

  const record = field as { readonly [key: string]: PackageExportsField | null };
  const keys = Object.keys(record);
  const isSubpathMap = keys.some((key) => key.startsWith('.'));

  if (isSubpathMap) {
    // Only the root subpath is meaningful to the host.
    return '.' in record ? resolveExports(record['.'] ?? null) : null;
  }

  for (const condition of HONORED_CONDITIONS) {
    if (condition in record) {
      const resolved = resolveExports(record[condition] ?? null);
      if (resolved !== null) {
        return resolved;
      }
    }
  }

  return null;
}

/**
 * Symlink-aware containment: `resolvePluginEntrypoint`'s check is pure path
 * arithmetic, which a link INSIDE the plugin tree pointing out of it (e.g.
 * `dist -> /`) defeats — the lexical path stays under the root while the
 * real file does not. This re-checks against `realpath` of both sides, so
 * containment holds regardless of whether the #84 extraction pipeline
 * rejects symlinks. Also serves as the existence check: a missing
 * entrypoint fails here with a plugin-attributed error instead of a raw
 * import() failure.
 *
 * Returns the real path, which is what should be handed to `import()`.
 */
export async function assertResolvedEntrypointContained(
  slug: string,
  entrypointPath: string,
  rootDir: string,
): Promise<string> {
  const realRoot = await realpathOrNull(resolve(rootDir));

  if (realRoot === null) {
    throw new PluginEntrypointError(slug, `plugin root '${rootDir}' cannot be resolved`);
  }

  const realEntrypoint = await realpathOrNull(entrypointPath);

  if (realEntrypoint === null) {
    throw new PluginEntrypointError(slug, `entrypoint '${entrypointPath}' does not exist`);
  }

  if (!isContained(realRoot, realEntrypoint)) {
    throw new PluginEntrypointError(slug, `entrypoint '${entrypointPath}' resolves outside the plugin directory`);
  }

  return realEntrypoint;
}
