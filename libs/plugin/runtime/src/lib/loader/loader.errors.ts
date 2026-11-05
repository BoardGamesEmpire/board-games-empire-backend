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

/**
 * The plugin artifact directory a row's `installedSha256` names holds another
 * version than the row activated, or a manifest whose version can't be read
 * (#224). Every artifact has a directory of its own, so this is drift — the
 * row activated with the code never placed, or the directory edited by hand —
 * and never a staged update awaiting consent.
 */
export class PluginDiskVersionMismatchError extends Error {
  override readonly name = 'PluginDiskVersionMismatchError';

  constructor(
    public readonly slug: string,
    public readonly expectedVersion: string,
    public readonly foundVersion: string | null,
  ) {
    super(
      `Plugin '${slug}' artifact directory holds ${
        foundVersion === null ? 'a manifest with no readable version' : `v${foundVersion}`
      }, but its version on record is v${expectedVersion}`,
    );
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
