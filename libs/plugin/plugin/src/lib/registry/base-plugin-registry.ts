import { DuplicatePluginRegistrationError, PluginDisabledError, PluginNotRegisteredError } from './registry.errors.js';

/**
 * One registry row as exposed by `list()`.
 */
export interface PluginRegistryEntry<TInstance> {
  readonly slug: string;
  readonly instance: TInstance;
  readonly enabled: boolean;
}

export interface RegisterOptions {
  /**
   * Initial enablement; defaults to `true` (a freshly loaded plugin is servable unless told otherwise).
   */
  readonly enabled?: boolean;
}

export interface ListFilter {
  /**
   * When set, only entries with matching enablement are returned.
   */
  readonly enabled?: boolean;
}

/**
 * Slug-keyed registry base for plugin category implementations (#59 Phase A,
 * decision D-F): generalized from the two concrete precedents — the storage
 * driver router (#100/#101) and the game-gateway driver registry (#193/#203)
 * — per the concrete-first rule (extract once ≥2 implementations validate
 * the shape). Category registries subclass with their instance type, e.g.
 * `class DataGatewayRegistry extends BasePluginRegistry<GameGatewayDriver>`.
 *
 * Two read paths with different contracts:
 *
 * - `get()` / `list()` — introspection. Disabled entries remain visible so
 *   diagnostics (#79) and the admin surface can show what exists and why it
 *   is not being served.
 * - `resolve()` — the SERVING path. Throws `PluginNotRegisteredError` for
 *   unknown slugs and `PluginDisabledError` for administratively disabled
 *   ones ("disabled driver is not served", #193). Request-path callers use
 *   this and let the error propagate to the exception filter.
 *
 * Not thread-safe beyond Node's single-threaded event loop guarantees; all
 * mutation happens during boot/lifecycle handling on the main loop.
 */
export abstract class BasePluginRegistry<TInstance> {
  /** Human-readable identity used in error messages, e.g. 'data-gateway'. */
  protected abstract readonly registryName: string;

  private readonly entries = new Map<string, { instance: TInstance; enabled: boolean }>();

  /** Number of registered entries, enabled or not. */
  public get size(): number {
    return this.entries.size;
  }

  public register(slug: string, instance: TInstance, options: RegisterOptions = {}): void {
    if (this.entries.has(slug)) {
      throw new DuplicatePluginRegistrationError(this.registryName, slug);
    }

    this.entries.set(slug, { instance, enabled: options.enabled ?? true });
  }

  /** Removes the entry entirely (uninstall path). Unknown slug is a wiring bug — throws. */
  public unregister(slug: string): void {
    if (!this.entries.delete(slug)) {
      throw new PluginNotRegisteredError(this.registryName, slug);
    }
  }

  public has(slug: string): boolean {
    return this.entries.has(slug);
  }

  /** Introspection read — returns the instance regardless of enablement, `undefined` when unregistered. */
  public get(slug: string): TInstance | undefined {
    return this.entries.get(slug)?.instance;
  }

  /** Serving read — the only path request handling should use. */
  public resolve(slug: string): TInstance {
    const entry = this.entries.get(slug);

    if (entry === undefined) {
      throw new PluginNotRegisteredError(this.registryName, slug);
    }

    if (!entry.enabled) {
      throw new PluginDisabledError(this.registryName, slug);
    }

    return entry.instance;
  }

  /** Flips enablement without touching the instance (admin enable/disable, `plugin.enabled`/`plugin.disabled`). */
  public setEnabled(slug: string, enabled: boolean): void {
    const entry = this.entries.get(slug);

    if (entry === undefined) {
      throw new PluginNotRegisteredError(this.registryName, slug);
    }

    entry.enabled = enabled;
  }

  public isEnabled(slug: string): boolean {
    const entry = this.entries.get(slug);

    if (entry === undefined) {
      throw new PluginNotRegisteredError(this.registryName, slug);
    }

    return entry.enabled;
  }

  /** Insertion-ordered snapshot; filter by enablement when requested. */
  public list(filter: ListFilter = {}): ReadonlyArray<PluginRegistryEntry<TInstance>> {
    const all = Array.from(this.entries.entries(), ([slug, entry]) => ({
      slug,
      instance: entry.instance,
      enabled: entry.enabled,
    }));

    return filter.enabled === undefined ? all : all.filter((entry) => entry.enabled === filter.enabled);
  }

  /** Test/reload helper — drops every entry. */
  public clear(): void {
    this.entries.clear();
  }
}
