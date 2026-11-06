import type { PluginModuleOptions } from '../plugin-module.options';

/**
 * Module options for specs (#1118). Every spec that builds `PluginModuleOptions`
 * goes through here, so a field added to the options (the process role, #1094)
 * gets its default in one place, not in every spec's literal.
 */
export function buildPluginModuleOptions(overrides: Partial<PluginModuleOptions> = {}): PluginModuleOptions {
  return {
    pluginsRoot: '/plugins',
    bgeVersion: '1.0.0',
    defaultLocale: 'en',
    processRole: 'api',
    ...overrides,
  };
}
