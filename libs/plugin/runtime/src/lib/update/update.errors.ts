import type { ManifestIssue } from '@boardgamesempire/plugin-manifest';
import type { StaticAnalysisFinding } from '../install/static-analysis.types';

/**
 * Typed failures for the update pipeline (#59 Phase C3). Domain errors, not
 * HTTP exceptions — the C4 update endpoints (and the #84 pipeline wrapping
 * this seam) own the status-code mapping, the same discipline as the
 * install, loader, and consent act errors. Every rejection leaves NO partial
 * state: staging and activation are each a single transaction, and every
 * check runs before it.
 */

/**
 * The caller answered a staging that is no longer the current one (#357): it
 * was resolved and another staged since — possibly the same version from the
 * same plugin artifact — or replaced while the request was in flight.
 * Approving or rejecting by slug alone would answer a staging nobody
 * reviewed, so approve and reject name the staging the staged-update read
 * reported, and any other current staging refuses with this.
 */
export class PluginUpdateStagingReplacedError extends Error {
  override readonly name = 'PluginUpdateStagingReplacedError';

  constructor(
    public readonly slug: string,
    /** The staging the caller named. Not the current one: the caller reads and reviews that before answering it. */
    public readonly stagingId: string,
  ) {
    super(
      `Plugin '${slug}' no longer has staging '${stagingId}' — the staged update changed since it was read; ` +
        'read it again before approving or rejecting it',
    );
  }
}

/** No `Plugin` row exists for the slug an update arrived for. */
export class PluginUpdatePluginNotFoundError extends Error {
  override readonly name = 'PluginUpdatePluginNotFoundError';

  constructor(public readonly slug: string) {
    super(`Plugin '${slug}' is not installed — updates address existing installs; use the install pipeline instead`);
  }
}

/**
 * The row exists but is a tombstone (`uninstalledAt` set): its code is
 * gone and its consent surface was purged, so there is nothing to update.
 * Reinstalling the slug clears the tombstone; that path is the installer's.
 */
export class PluginUpdateTombstonedError extends Error {
  override readonly name = 'PluginUpdateTombstonedError';

  constructor(
    public readonly slug: string,
    public readonly uninstalledAt: Date,
  ) {
    super(
      `Plugin '${slug}' was uninstalled at ${uninstalledAt.toISOString()} — a tombstoned plugin cannot be updated; reinstall it instead`,
    );
  }
}

/** The updater is not a server admin. Update consent is a server-admin act, exactly as install consent is. */
export class PluginUpdateAuthorityError extends Error {
  override readonly name = 'PluginUpdateAuthorityError';

  constructor(public readonly actorId: string) {
    super(
      `Actor '${actorId}' lacks authority: staging, approving, or rejecting a plugin update requires a server admin`,
    );
  }
}

/**
 * Which manifest failed: the transport boundary maps these differently, so
 * the class must say which one it is rather than leaving the distinction in
 * message prose.
 *
 * - `'new'` — the submitted manifest: a caller error the author can fix.
 * - `'pending'` — the STORED staged manifest re-validated at approve time.
 *   The likely cause is a bgeCompat lapse (BGE upgraded between stage and
 *   approve) and the caller-actionable remedy is rejecting the staged
 *   update, which clears the state either way — but drift here is
 *   corruption, so it also warrants a loud log.
 * - `'active'` — the STORED active manifest: corrupted server state, never
 *   a caller error (the same contract as `PluginUnitManifestError`).
 */
export type PluginUpdateManifestSource = 'new' | 'pending' | 'active';

/** The new (or stored pending/active) manifest is unreadable, invalid, or does not describe the plugin it arrived for. */
export class PluginUpdateManifestError extends Error {
  override readonly name = 'PluginUpdateManifestError';

  constructor(
    public readonly slug: string,
    public readonly source: PluginUpdateManifestSource,
    detail: string,
    public readonly issues?: readonly ManifestIssue[],
  ) {
    super(`Plugin '${slug}' update manifest rejected (${source}): ${detail}`);
  }
}

/** The new manifest carries the version that is already active — there is nothing to update to. */
export class PluginUpdateVersionConflictError extends Error {
  override readonly name = 'PluginUpdateVersionConflictError';

  constructor(
    public readonly slug: string,
    public readonly version: string,
  ) {
    super(`Plugin '${slug}' version '${version}' is already active — an update must carry a different version`);
  }
}

/**
 * Another plugin artifact became active while this update was being staged,
 * so what this update was compared against is no longer the active plugin
 * artifact (#1096). Its version may even be the same number, from other
 * content. Nothing of the update is activated; staging it again compares it
 * with the plugin artifact that is active now.
 */
export class PluginUpdateActiveVersionMovedError extends Error {
  override readonly name = 'PluginUpdateActiveVersionMovedError';

  constructor(
    public readonly slug: string,

    /** The active version the update was compared against. */
    public readonly comparedVersion: string,

    /** The version that is active now. */
    public readonly activeVersion: string,
  ) {
    super(
      `Plugin '${slug}' changed to version '${activeVersion}' while this update, compared with version ` +
        `'${comparedVersion}', was being staged; stage the update again so that it is compared with the active version`,
    );
  }
}

/**
 * A pending update is already staged. Refused rather than superseded: the
 * staged version may already be sitting in front of an admin, and silently
 * replacing it would discard an in-flight consent decision and leave the
 * lifecycle timeline claiming a version was staged and never resolved.
 * Reject the pending one, then stage this.
 */
export class PluginUpdatePendingConflictError extends Error {
  override readonly name = 'PluginUpdatePendingConflictError';

  constructor(
    public readonly slug: string,
    public readonly pendingVersion: string,
    public readonly incomingVersion: string,
  ) {
    super(
      `Plugin '${slug}' already has version '${pendingVersion}' staged pending consent; refusing to replace it with ` +
        `'${incomingVersion}' — resolve the staged update (approve or reject) first`,
    );
  }
}

/**
 * The update makes the plugin a data-gateway plugin, so activating it places
 * the plugin's DataGateway row, and another DataGateway holds the name the
 * row would take (#1083). Renaming the holder is the only way on, because
 * `DataGateway.name` is unique across every row, a deleted one included
 * (#754). Nothing of the update is activated, and a staged one stays staged.
 */
export class PluginUpdateDataGatewayNameConflictError extends Error {
  override readonly name = 'PluginUpdateDataGatewayNameConflictError';

  constructor(
    public readonly slug: string,
    /** The DataGateway name the update would have taken. */
    public readonly dataGatewayName: string,
  ) {
    super(
      `Plugin '${slug}' cannot be updated into a data-gateway plugin: a DataGateway named '${dataGatewayName}' already exists`,
    );
  }
}

/** `approve`/`reject` addressed a plugin with no staged pending update. */
export class PluginUpdateNoPendingError extends Error {
  override readonly name = 'PluginUpdateNoPendingError';

  constructor(public readonly slug: string) {
    super(`Plugin '${slug}' has no staged pending update to resolve`);
  }
}

/** Validation step 3, DB half, update edition: `checks[]` core slugs that do not exist in `Permission`. Collect-all. */
export class PluginUpdateUnknownCorePermissionError extends Error {
  override readonly name = 'PluginUpdateUnknownCorePermissionError';

  constructor(
    public readonly slug: string,
    public readonly missingSlugs: readonly string[],
  ) {
    super(
      `Plugin '${slug}' update requests ${missingSlugs.length} core permission(s) that do not exist: ` +
        `${missingSlugs.join(', ')} — if one was meant to be plugin-declared, add it to permissions.declares`,
    );
  }
}

/** The next manifest declares or requests a categorically ungrantable permission — same rule the installer enforces. */
export class PluginUpdateForbiddenPermissionError extends Error {
  override readonly name = 'PluginUpdateForbiddenPermissionError';

  constructor(
    public readonly slug: string,
    public readonly permissionSlug: string,
    detail: string,
  ) {
    super(`Plugin '${slug}' update may not proceed: '${permissionSlug}' ${detail}`);
  }
}

/**
 * The Critical confirmation, update edition (#59): any Critical
 * permission approval newly confers (one with no consent decision, a denied
 * one, or one granted at a risk that no longer covers today's) demands exact
 * re-entry — every one, nothing else (#1336).
 */
export class PluginUpdateCriticalConfirmationError extends Error {
  override readonly name = 'PluginUpdateCriticalConfirmationError';

  constructor(
    public readonly slug: string,
    public readonly expectedSlugs: readonly string[],
    public readonly receivedSlugs: readonly string[],
  ) {
    super(
      `Plugin '${slug}' update requires explicit confirmation of ${expectedSlugs.length} Critical permission(s) it ` +
        `will grant: expected exact re-entry of [${expectedSlugs.join(', ')}], received [${receivedSlugs.join(', ')}]`,
    );
  }
}

/**
 * Static analysis of the new version found forbidden specifiers and the
 * staging admin did not accept them — the same overridable gate, with the
 * same exact re-entry discipline, that installs use. An update
 * path weaker than the install path would make version 2 the obvious place
 * to smuggle what version 1 could not carry.
 */
export class PluginUpdateStaticAnalysisError extends Error {
  override readonly name = 'PluginUpdateStaticAnalysisError';

  constructor(
    public readonly slug: string,
    public readonly findings: readonly StaticAnalysisFinding[],
    public readonly unacknowledgedSpecifiers: readonly string[] = [],
    public readonly unexpectedSpecifiers: readonly string[] = [],
  ) {
    super(
      unexpectedSpecifiers.length > 0
        ? `Plugin '${slug}' update acknowledgement names ${unexpectedSpecifiers.length} specifier(s) static analysis ` +
            `did not report (${unexpectedSpecifiers.join(', ')}); the report and the acceptance must describe the same update`
        : `Plugin '${slug}' update failed static analysis with ${findings.length} forbidden import(s); ` +
            `${unacknowledgedSpecifiers.length} unacknowledged [${unacknowledgedSpecifiers.join(', ')}] — ` +
            're-enter every reported specifier via acknowledgeForbiddenImports to accept the risk and proceed',
    );
  }
}
