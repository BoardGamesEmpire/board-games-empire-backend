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
 */
export class DynamicImportPluginModuleImporter implements PluginModuleImporter {
  async importModule(entrypointPath: string): Promise<Record<string, unknown>> {
    return (await import(pathToFileURL(entrypointPath).href)) as Record<string, unknown>;
  }
}
