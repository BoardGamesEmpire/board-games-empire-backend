import type { PluginActorView } from './plugin-actor-view.js';

/**
 * The capability surface the host hands a plugin factory (#59). Plugins
 * receive ONLY this — never host DI, never raw infrastructure services.
 * Worker mode (#197) implements the same interface with host-side RPC
 * shims, so nothing here may assume in-process identity.
 *
 * Deliberately narrow at Phase B: logger, config, namespaced event
 * emission, and read-only actor access — the capabilities with concrete
 * host machinery behind them today. The manifest-scoped outbound HTTP
 * capability (per-plugin `SecureHttpService` bound to `outboundDomains`)
 * and category context wrappers join the interface with their first
 * consumers (#194 gateway plugins / #61 storage drivers) per the
 * concrete-first rule — an untestable speculative binding helps nobody.
 */
export interface PluginContext {
  readonly pluginId: string;
  readonly slug: string;
  readonly logger: PluginLogger;
  readonly config: PluginConfigAccessor;
  readonly events: PluginEventPublisher;
  readonly actor: PluginActorAccessor;
}

/**
 * Structural logging surface. The in-process implementation wraps the host
 * logger with a `plugin:<slug>` context so every line a plugin writes is
 * attributable; keeping the interface structural (rather than exposing the
 * host logger class) is what lets the worker shim forward log calls over
 * RPC without pretending to be pino.
 */
export interface PluginLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Read access to the plugin's SERVER-scope configuration (`Plugin.config`).
 * Snapshots are hot-reloaded across processes via the config pub/sub
 * channel; `current()` always returns the latest complete snapshot, never a
 * mid-refresh view. Household-scope configuration is a per-request concern
 * and arrives with the category context wrappers, not here.
 */
export interface PluginConfigAccessor {
  current(): Readonly<Record<string, unknown>>;
}

/**
 * Emission into the host event bus, restricted to the events the manifest
 * DECLARED (`events.emits`, all under `plugin.<slug>.*`). Undeclared names
 * throw — consent surfaces showed admins the declared list at install time,
 * so emitting outside it is a contract violation, not a soft warning.
 */
export interface PluginEventPublisher {
  emit(eventName: string, payload: unknown): void;
}

/**
 * Read-only view of the CLS actor. Plugins can inspect who triggered the
 * current execution but can never set or forge it — population happens only
 * through the host's sanctioned scope openers.
 */
export interface PluginActorAccessor {
  current(): PluginActorView | null;
}
