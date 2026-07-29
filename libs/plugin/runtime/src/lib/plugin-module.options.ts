import { ConfigurableModuleBuilder } from '@nestjs/common';

/**
 * Host-supplied configuration for `PluginModule`. All values are explicit —
 * the module derives nothing from the environment on its own, so a host app
 * (or a test) states exactly which roots and version identity it runs with.
 */
export interface PluginModuleOptions {
  /** Root directory for tarball-installed plugins (`<pluginsRoot>/<slug>`), populated by the #84 pipeline. */
  readonly pluginsRoot: string;
  /** Root directory for plugins shipped in-tree with BGE (`<bundledRoot>/<slug>`). */
  readonly bundledRoot: string;
  /** Running BGE version for manifest `bgeCompat` evaluation — build-time injected constant per #59. */
  readonly bgeVersion: string;
  /** Server default locale for manifest localization resolution. */
  readonly defaultLocale: string;
}

export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = new ConfigurableModuleBuilder<PluginModuleOptions>()
  .setClassMethodName('forRoot')
  .build();
