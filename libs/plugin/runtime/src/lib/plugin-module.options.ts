import type { PluginCategory } from '@bge/database';
import { ConfigurableModuleBuilder } from '@nestjs/common';

/** Why a plugin factory's product can't be adopted, or null when it can. */
export type PluginProductCheck = (product: unknown) => string | null;

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
  /**
   * What kind of process this is: `'api'`, or `'coordinator'` for the
   * process that hosts the data-gateway plugins (#1083). It labels the plugin
   * load records the process writes (#1094), and must be the process role
   * `roleLoading` answers for each category in {@link loadCategories}.
   */
  readonly processRole: string;
  /** Server default locale for manifest localization resolution. */
  readonly defaultLocale: string;

  /**
   * The plugin categories this process loads (#1083). Each category runs in
   * the process that serves it, as one copy, so a process loads only the
   * plugins of the categories it names; one that names none loads nothing.
   */
  readonly loadCategories: readonly PluginCategory[];

  /**
   * Whether this process's plugin load records say ready only once the host
   * serves (#1083). The coordinator's do: a gateway worker that reads a ready
   * record dials the coordinator, and Nest runs the bootstrap hooks, where
   * the plugins load, before a microservice's gRPC server listens. A record
   * ready any earlier would have the gateway worker dial nothing and count
   * each failure against the plugin DataGateway. Such a host calls
   * `PluginLoadRecorder.markServing()` once it listens. Without it, a load
   * says ready as soon as its plugin is registered, as the api's do: no
   * process dials the api for a plugin.
   */
  readonly readyOnceServing?: boolean;

  /**
   * The server's check, per category, that a factory's product is what the
   * process hosting that category can serve (#1083). It runs before the
   * product is registered; a reason it returns quarantines the plugin like
   * any other load failure. A category without a check adopts any product.
   */
  readonly productChecks?: Partial<Record<PluginCategory, PluginProductCheck>>;
}

export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = new ConfigurableModuleBuilder<PluginModuleOptions>()
  .setClassMethodName('forRoot')
  .build();
