/**
 * Typed failure modes for `BasePluginRegistry` (#59 Phase A).
 *
 * Fail-loud by design: an unknown or disabled slug on the serving path is a
 * wiring bug or an admin action the caller must surface, never a silent
 * fallback (same posture as `DriverNotRegisteredError` on the storage
 * router, #100/#101, and the gateway registry, #193/#203).
 */
export abstract class PluginRegistryError extends Error {
  protected constructor(
    message: string,

    /**
     * Human-readable registry identity, e.g. 'data-gateway'.
     */
    public readonly registryName: string,
    public readonly slug: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * `register()` called for a slug that is already present.
 */
export class DuplicatePluginRegistrationError extends PluginRegistryError {
  constructor(registryName: string, slug: string) {
    super(`Plugin '${slug}' is already registered in the ${registryName} registry`, registryName, slug);
  }
}

/**
 * The slug has never been registered (or was unregistered).
 */
export class PluginNotRegisteredError extends PluginRegistryError {
  constructor(registryName: string, slug: string) {
    super(`Plugin '${slug}' is not registered in the ${registryName} registry`, registryName, slug);
  }
}

/**
 * The slug is registered but administratively disabled — `resolve()` refuses to serve it (#193).
 */
export class PluginDisabledError extends PluginRegistryError {
  constructor(registryName: string, slug: string) {
    super(`Plugin '${slug}' is registered in the ${registryName} registry but disabled`, registryName, slug);
  }
}
