import type { ManifestIssue } from '@boardgamesempire/plugin-manifest';
import type { StaticAnalysisFinding } from './static-analysis.types';

/**
 * Typed failures for the install pipeline (#59 Phase C2). Domain errors, not
 * HTTP exceptions — the C4 install endpoints (and the #84 pipeline wrapping
 * this seam) own the mapping to status codes, same discipline as the loader
 * and grant errors. Every rejection leaves NO partial state: the persist is
 * a single transaction and every check runs before it.
 */

/** The provenance input and the resolved directory disagree about `bundled` — corrupted pipeline state, never an author error. */
export class PluginInstallProvenanceMismatchError extends Error {
  override readonly name = 'PluginInstallProvenanceMismatchError';

  constructor(
    public readonly slug: string,
    detail: string,
  ) {
    super(`Plugin '${slug}' provenance is inconsistent with its directory: ${detail}`);
  }
}

/** The manifest is unreadable, invalid, or does not describe the directory it arrived in. */
export class PluginInstallManifestError extends Error {
  override readonly name = 'PluginInstallManifestError';

  constructor(
    public readonly slug: string,
    detail: string,
    public readonly issues?: readonly ManifestIssue[],
  ) {
    super(`Plugin '${slug}' manifest rejected at install: ${detail}`);
  }
}

/** The installer is not a server admin (D-AD). `manage:plugin` guard enforcement arrives with the C4 seeds. */
export class PluginInstallAuthorityError extends Error {
  override readonly name = 'PluginInstallAuthorityError';

  constructor(public readonly installerId: string) {
    super(`Installer '${installerId}' lacks authority: installing a plugin requires a server admin`);
  }
}

/** Validation step 3, DB half: `checks[]` core slugs that do not exist in the `Permission` table. Collect-all, like the validator. */
export class PluginInstallUnknownCorePermissionError extends Error {
  override readonly name = 'PluginInstallUnknownCorePermissionError';

  constructor(
    public readonly slug: string,
    public readonly missingSlugs: readonly string[],
  ) {
    super(
      `Plugin '${slug}' requests ${missingSlugs.length} core permission(s) that do not exist: ` +
        `${missingSlugs.join(', ')} — if one was meant to be plugin-declared, add it to permissions.declares`,
    );
  }
}

/**
 * The manifest declares or requests a categorically ungrantable permission:
 * a plugin-administration slug (self-escalation loop, D-Z) or an
 * `'all'`-wildcard subject. Enforced at install — every grant for it would
 * fail C1's hard exclusion anyway, so the honest outcome is rejecting the
 * install rather than shipping a plugin whose consent surface can never be
 * satisfied.
 */
export class PluginInstallForbiddenPermissionError extends Error {
  override readonly name = 'PluginInstallForbiddenPermissionError';

  constructor(
    public readonly slug: string,
    public readonly permissionSlug: string,
    detail: string,
  ) {
    super(`Plugin '${slug}' may not be installed: '${permissionSlug}' ${detail}`);
  }
}

/**
 * The Critical second factor (D-AE / D-AI) was not satisfied:
 * `confirmCriticalSlugs` must re-enter EXACTLY the Critical slugs this
 * install will GRANT — every one of them, and nothing else.
 *
 * Deliberately not keyed on the manifest's `required` flag: every
 * server-consentable check is seeded `Granted`, so an optional Critical
 * permission confers identical authority, and `required` describes feature
 * degradation rather than risk. Carries both sets so the C4 surface can
 * render the confirmation prompt from the error itself.
 */
export class PluginInstallCriticalConfirmationError extends Error {
  override readonly name = 'PluginInstallCriticalConfirmationError';

  constructor(
    public readonly slug: string,
    public readonly expectedSlugs: readonly string[],
    public readonly receivedSlugs: readonly string[],
  ) {
    super(
      `Plugin '${slug}' requires explicit confirmation of ${expectedSlugs.length} Critical required permission(s): ` +
        `expected exact re-entry of [${expectedSlugs.join(', ')}], received [${receivedSlugs.join(', ')}]`,
    );
  }
}

/**
 * Static analysis found forbidden specifiers in the default scan and the
 * installing admin did not accept them (D-AC).
 *
 * The gate is overridable on purpose: this list is a lint aimed at honest
 * authors, not a sandbox — trivial obfuscation defeats it, so treating it as
 * an unbypassable wall would only block operators with legitimate edge cases
 * on their OWN instance. The admin re-enters each specifier via
 * `acknowledgeForbiddenImports` to proceed, and the acceptance is recorded on
 * the install event. Carries every set difference so the consent surface can
 * render the prompt straight from the error.
 */
export class PluginInstallStaticAnalysisError extends Error {
  override readonly name = 'PluginInstallStaticAnalysisError';

  constructor(
    public readonly slug: string,
    /** The gating findings from the default scan. */
    public readonly findings: readonly StaticAnalysisFinding[],
    /** Forbidden specifiers still needing acceptance — what the admin must re-enter to proceed. */
    public readonly unacknowledgedSpecifiers: readonly string[] = [],
    /** Specifiers the acknowledgement named that analysis did not report — caller and server disagree about state. */
    public readonly unexpectedSpecifiers: readonly string[] = [],
  ) {
    super(
      unexpectedSpecifiers.length > 0
        ? `Plugin '${slug}' acknowledgement names ${unexpectedSpecifiers.length} specifier(s) static analysis did not ` +
            `report (${unexpectedSpecifiers.join(', ')}); the report and the acceptance must describe the same install`
        : `Plugin '${slug}' failed static analysis with ${findings.length} forbidden import(s): ` +
            `${findings.map((finding) => `${finding.specifier ?? '<unknown>'} (${finding.file})`).join(', ')}. ` +
            `Re-enter ${unacknowledgedSpecifiers.length > 0 ? unacknowledgedSpecifiers.join(', ') : 'each specifier'} ` +
            'in acknowledgeForbiddenImports to install anyway.',
    );
  }
}

/** A plugin with this slug is already installed. Updates are the C3 flow, not a reinstall. */
export class PluginInstallConflictError extends Error {
  override readonly name = 'PluginInstallConflictError';

  constructor(public readonly slug: string) {
    super(`Plugin '${slug}' is already installed — updates go through the pending/approve flow, not a reinstall`);
  }
}

/**
 * A declared permission's canonical slug already exists in the catalog
 * (validation step 4). Structurally near-unreachable — the canonical form
 * embeds the `@unique` plugin slug and rows cascade-delete with their plugin
 * — so hitting this means corrupted state; the `PluginPermission.slug`
 * unique index backstops the race window behind this readable pre-check.
 */
export class PluginInstallPermissionCollisionError extends Error {
  override readonly name = 'PluginInstallPermissionCollisionError';

  constructor(
    public readonly slug: string,
    public readonly collidingSlugs: readonly string[],
  ) {
    super(`Plugin '${slug}' declares permission slug(s) that already exist: ${collidingSlugs.join(', ')}`);
  }
}
