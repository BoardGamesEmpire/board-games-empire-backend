import { pathToFileURL } from 'node:url';

/**
 * Seam around dynamic `import()` so the loader is testable without real
 * module resolution and so worker mode (#197) can substitute an importer
 * that loads the entrypoint inside a worker thread and returns RPC shims.
 */
export interface PluginModuleImporter {
  importModule(entrypointPath: string): Promise<Record<string, unknown>>;
}

export const PLUGIN_MODULE_IMPORTER = Symbol('PLUGIN_MODULE_IMPORTER');

/**
 * Default in-process importer: `import()` via a file URL (Windows-safe;
 * a bare absolute path is not a valid ESM specifier there).
 *
 * The `webpackIgnore` comment is what makes the import real in a built app.
 * The apps are webpack bundles, and webpack compiles an `import()` of an
 * expression into a lookup in a map of the modules it bundled. A plugin's
 * entrypoint is a path known only at boot, so that map is empty and every
 * lookup rejects with "Cannot find module", which the loader reads as a
 * plugin that failed to load. With the comment, webpack leaves the call as
 * Node's own `import()`, which reads the file from disk (#1083). The comment
 * has to stay inside the call's parentheses: webpack reads it from there.
 */
export class DynamicImportPluginModuleImporter implements PluginModuleImporter {
  async importModule(entrypointPath: string): Promise<Record<string, unknown>> {
    // A module namespace object is always an object keyed by export name, so
    // `import()`'s untyped result fits this annotation without a check.
    const namespace: Record<string, unknown> = await import(
      /* webpackIgnore: true */ pathToFileURL(entrypointPath).href
    );

    return namespace;
  }
}
