import type { ManifestIssue } from '@boardgamesempire/plugin-manifest';
import { describeManifestMove, type PluginChangeKind } from '../manifest/manifest-move';

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
    super(
      `Actor '${actorId}' lacks authority: enabling, disabling, configuring, or uninstalling a plugin requires a server admin`,
    );
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
 * The active plugin manifest was replaced, or the plugin reinstalled, between
 * the config write's read and its locked transaction, so the document it
 * validated was judged against a plugin manifest that is no longer the stored
 * one (#578). `kind` names which writer moved it; the version pair makes the
 * retry informed, though it alone cannot say whether consent survived.
 * Retryable, and immediately: the writer that moved it has already committed.
 *
 * The slug is `pluginSlug`, as on `PluginUnitPluginChangedError`, so one
 * renderer serves every plugin manifest move refusal.
 */
export class PluginLifecyclePluginChangedError extends Error {
  override readonly name = 'PluginLifecyclePluginChangedError';

  constructor(
    public readonly pluginSlug: string,
    public readonly kind: PluginChangeKind,
    public readonly expectedVersion: string,
    public readonly actualVersion: string,
  ) {
    super(describeManifestMove(pluginSlug, kind, expectedVersion, actualVersion));
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
