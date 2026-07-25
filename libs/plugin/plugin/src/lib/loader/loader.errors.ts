/**
 * Typed failures for the boot-time loader path (#59 Phase B). Every class
 * carries the plugin slug so the quarantine handler can persist a precise
 * `loadError` without string parsing. These are HOST errors — they never
 * cross into plugin code.
 */

export class PluginDirectoryNotFoundError extends Error {
  override readonly name = 'PluginDirectoryNotFoundError';

  constructor(
    public readonly slug: string,
    public readonly expectedPath: string,
  ) {
    super(`Plugin '${slug}' directory not found at ${expectedPath}`);
  }
}

export class PluginDirectoryLayoutError extends Error {
  override readonly name = 'PluginDirectoryLayoutError';

  constructor(
    public readonly slug: string,
    reason: string,
  ) {
    super(`Plugin '${slug}' directory layout invalid: ${reason}`);
  }
}

export class PluginEntrypointError extends Error {
  override readonly name = 'PluginEntrypointError';

  constructor(
    public readonly slug: string,
    reason: string,
  ) {
    super(`Plugin '${slug}' entrypoint resolution failed: ${reason}`);
  }
}

/** The imported module does not satisfy the factory contract (default-exported function). */
export class PluginModuleShapeError extends Error {
  override readonly name = 'PluginModuleShapeError';

  constructor(
    public readonly slug: string,
    reason: string,
  ) {
    super(`Plugin '${slug}' module shape invalid: ${reason}`);
  }
}

/** A plugin attempted to emit an event it did not declare in `events.emits`. */
export class PluginEmitNotDeclaredError extends Error {
  override readonly name = 'PluginEmitNotDeclaredError';

  constructor(
    public readonly slug: string,
    public readonly eventName: string,
  ) {
    super(`Plugin '${slug}' attempted to emit undeclared event '${eventName}' — declare it in manifest events.emits`);
  }
}
