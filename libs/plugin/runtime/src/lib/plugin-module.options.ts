import { ConfigurableModuleBuilder } from '@nestjs/common';

/**
 * Host-supplied configuration for `PluginModule`. All values are explicit —
 * the module derives nothing from the environment on its own, so a host app
 * (or a test) states exactly which plugin root and version identity it runs with.
 */
export interface PluginModuleOptions {
  /**
   * Root directory for installed plugins, one directory per plugin artifact
   * (`<pluginsRoot>/<slug>/<sha256>`, #224), which the install ingress
   * populates (#1094). The only one: no plugin ships inside the server
   * (#696).
   */
  readonly pluginsRoot: string;
  /** Running BGE version for manifest `bgeCompat` evaluation — build-time injected constant per #59. */
  readonly bgeVersion: string;
  /** Server default locale for manifest localization resolution. */
  readonly defaultLocale: string;
}

export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = new ConfigurableModuleBuilder<PluginModuleOptions>()
  .setClassMethodName('forRoot')
  .build();
