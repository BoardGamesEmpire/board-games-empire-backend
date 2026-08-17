import type { ManifestIssue } from '@boardgamesempire/plugin-manifest';

/**
 * Typed failures for the server lifecycle surface (#320): enable, disable,
 * server config write, uninstall. Domain errors, not HTTP exceptions — the
 * API filter owns the status mapping, the same discipline as the install,
 * update, and grant errors.
 */

/** The actor is not a server admin. Lifecycle control is a server-admin act, exactly as install and update consent are. */
export class PluginLifecycleAuthorityError extends Error {
  override readonly name = 'PluginLifecycleAuthorityError';

  constructor(public readonly actorId: string) {
    super(`Actor '${actorId}' lacks authority: enabling, disabling, configuring, or uninstalling a plugin requires a server admin`);
  }
}

/** No `Plugin` row exists for the slug. */
export class PluginLifecycleNotFoundError extends Error {
  override readonly name = 'PluginLifecycleNotFoundError';

  constructor(public readonly slug: string) {
    super(`Plugin '${slug}' is not installed`);
  }
}

/**
 * The row exists but is a tombstone (`uninstalledAt` set): its code is gone
 * and its consent surface was purged. Uninstall force-disabled it already,
 * so there is nothing to enable, disable, configure, or uninstall again —
 * reinstalling the slug clears the tombstone; that path is the installer's.
 */
export class PluginLifecycleTombstonedError extends Error {
  override readonly name = 'PluginLifecycleTombstonedError';

  constructor(
    public readonly slug: string,
    public readonly uninstalledAt: Date,
  ) {
    super(`Plugin '${slug}' was uninstalled at ${uninstalledAt.toISOString()} — reinstall it to manage it again`);
  }
}

/**
 * `bundled` plugins ship with BGE core: no tarball, no independent removal —
 * they upgrade with BGE itself, so uninstall is refused and disable is the
 * admin's kill switch.
 */
export class PluginUninstallBundledError extends Error {
  override readonly name = 'PluginUninstallBundledError';

  constructor(public readonly slug: string) {
    super(`Plugin '${slug}' is bundled with BGE and cannot be uninstalled — disable it instead`);
  }
}

/** The stored active manifest failed re-validation on the config write path — corrupted server state, never a caller error. */
export class PluginLifecycleManifestError extends Error {
  override readonly name = 'PluginLifecycleManifestError';

  constructor(
    public readonly pluginSlug: string,
    detail: string,
    public readonly issues?: readonly ManifestIssue[],
  ) {
    super(`Stored manifest for plugin '${pluginSlug}' is invalid: ${detail}`);
  }
}
