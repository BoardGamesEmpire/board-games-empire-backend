import {
  DatabaseService,
  PluginGrantScope,
  PluginGrantStatus,
  Prisma,
  RiskLevel,
  type HouseholdPlugin,
  type Permission,
  type Plugin,
  type PluginGrant,
  type UserPlugin,
} from '@bge/database';
import type { InstalledPluginDirectory } from '@boardgamesempire/plugin-contract';
import {
  PluginManifestValidationError,
  resolveLocalizedString,
  validatePluginManifest,
  type ManifestWarning,
  type NormalizedPermissionRequest,
  type PluginManifestValidationResult,
} from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { readFile } from 'node:fs/promises';
import {
  HouseholdPluginUnitDisabledEvent,
  PluginGrantRevokedEvent,
  PluginUpdateApprovedEvent,
  PluginUpdatePendingEvent,
  PluginUpdateRejectedEvent,
  UserPluginUnitDisabledEvent,
  type GrantedPermissionRecord,
  type PluginGrantRevocationReason,
} from '../events/plugin.events';
import { PluginGrantAuthorityService } from '../grants/plugin-grant-authority.service';
import { CONSENT_SCOPE_TO_GRANT_SCOPE, SERVER_SCOPE_SENTINEL } from '../grants/plugin-grant.service';
import { riskCovers } from '../grants/risk-ordering';
import {
  collectForbiddenPermissionViolations,
  collectWildcardSubjectViolations,
  compareExactReentry,
  criticalConfirmationExpectation,
  resolveForbiddenSpecifierAcknowledgement,
} from '../install/consent-gates';
import { MANIFEST_SCOPE_TO_PRISMA } from '../install/manifest-enum.maps';
import { PluginStaticAnalysisService } from '../install/plugin-static-analysis.service';
import { gatingFindings, type StaticAnalysisReport } from '../install/static-analysis.types';
import { MODULE_OPTIONS_TOKEN, type PluginModuleOptions } from '../plugin-module.options';
import { MANIFEST_CATEGORY_TO_PRISMA } from '../registry/plugin-category.map';
import { compareForEscalations } from './escalation-comparator';
import type { ManifestComparisonView, UpdateEscalation, UpdateEscalationComparison } from './update-escalation.types';
import {
  PluginUpdateAuthorityError,
  PluginUpdateBlockedByDenialError,
  PluginUpdateCriticalConfirmationError,
  PluginUpdateForbiddenPermissionError,
  PluginUpdateManifestError,
  PluginUpdateNoPendingError,
  PluginUpdatePendingConflictError,
  PluginUpdatePluginNotFoundError,
  PluginUpdateProvenanceMismatchError,
  PluginUpdateStaticAnalysisError,
  PluginUpdateTombstonedError,
  PluginUpdateUnknownCorePermissionError,
  PluginUpdateVersionConflictError,
} from './update.errors';

/**
 * Typed update provenance, mirroring D-AG's install shape: `bundled = false
 * ⇒ pendingSha256` is unrepresentable-when-violated. URL/registry
 * provenance columns keep describing the INSTALL; #84 extends this when its
 * ingress metadata needs to ride an update.
 */
export type PluginUpdateProvenance =
  | { readonly bundled: true }
  | { readonly bundled: false; readonly pendingSha256: string };

export interface PluginUpdateStageInput {
  /** The NEW version's resolved directory — placed by #84 (or the bundled resolver); this service never touches a tarball (D-Y/D-AN). */
  readonly directory: InstalledPluginDirectory;
  readonly provenance: PluginUpdateProvenance;
  /** The staging admin — server-admin authority is verified, never assumed (D-AD parity). */
  readonly initiatorId: string;
  /** Admin opt-in: extend static analysis into node_modules; findings advisory only (D-AC). */
  readonly deepScan?: boolean;
  /** Exact re-entry of every forbidden import specifier analysis reported on the NEW version (D-AJ parity). */
  readonly acknowledgeForbiddenImports?: readonly string[];
}

export interface PluginUpdateStageResult {
  readonly plugin: Plugin;
  /** True when no server-gating escalation existed and the update activated immediately (D-AN). */
  readonly activated: boolean;
  readonly comparison: UpdateEscalationComparison;
  readonly analysis: StaticAnalysisReport;
  readonly warnings: readonly ManifestWarning[];
  readonly acknowledgedForbiddenImports: readonly string[];
  /** Populated on immediate activation; empty when the update was staged pending. */
  readonly seededGrants: readonly PluginGrant[];
}

export interface PluginUpdateApproveInput {
  readonly slug: string;
  readonly approverId: string;
  /** Exact re-entry of every Critical permission slug this approval will GRANT (D-AE/D-AI parity). */
  readonly confirmCriticalSlugs?: readonly string[];
}

export interface PluginUpdateApproveResult {
  readonly plugin: Plugin;
  readonly comparison: UpdateEscalationComparison;
  /** Server-scope grants seeded by this approval — the new server-consentable checks. */
  readonly seededGrants: readonly PluginGrant[];
}

export interface PluginUpdateRejectInput {
  readonly slug: string;
  readonly rejectorId: string;
}

/** One unit activation decided to suspend, with the slugs that forced it. */
interface SuspensionCandidate<TUnit> {
  readonly before: TUnit;
  readonly after: TUnit;
  readonly outstanding: readonly string[];
}

interface ActivationOutcome {
  readonly plugin: Plugin;
  readonly seededGrants: readonly PluginGrant[];
  readonly revokedGrants: readonly PluginGrant[];
  /** Grants deleted because their permission moved consent scope. */
  readonly scopeMovedGrants: readonly PluginGrant[];
  /** Server-scope grants whose `decidedRiskLevel` this approval refreshed (D-X). */
  readonly reStampedGrants: readonly PluginGrant[];
  readonly suspendedHouseholdUnits: readonly SuspensionCandidate<HouseholdPlugin>[];
  /** User units suspended pending re-consent — the household pass's exact user-scope mirror (#225). */
  readonly suspendedUserUnits: readonly SuspensionCandidate<UserPlugin>[];
}

/**
 * The update consent seam (#59 Phase C3, D-AN): the DB/consent half of a
 * plugin update. #84's distribution pipeline wraps `stage()` exactly as it
 * wraps `install()` — ingress, SHA-256 verification, extraction, and disk
 * placement of the new version stay there, as does removing a rejected
 * version's staged files.
 *
 * `stage()` validates the new manifest (with `bgeCompat` ENFORCED — a
 * version that cannot load must not be activatable), screens it through the
 * SAME consent gates as install (categorical exclusions, core-permission
 * existence, static analysis with the D-AJ overridable specifier gate),
 * runs the D-AP escalation comparison against the ACTIVE manifest, and then
 * either activates immediately (no server-gating escalation, no D-AB
 * denial block) or writes the pending columns and emits
 * `plugin.update_pending` for the admin surface.
 *
 * ACTIVATION never hot-swaps running code (D-AT): the transaction promotes
 * the DB state — version, manifest, the D-AF `declares[]` catalog diff with
 * `'permission-removed'` grant revocation, per-unit suspension for
 * required-at-household-scope escalations (D-AO) — and sets
 * `restartRequired`; the running instance continues on the prior code until
 * the next boot, where the loader clears the flag. No forced restart:
 * updating several plugins in one sitting must not bounce the server N
 * times. A real teardown path arrives with #197's worker mode.
 *
 * User-scope escalations suspend `UserPlugin` units exactly as household
 * escalations suspend `HouseholdPlugin` units (#225) — same batched shape,
 * same guarded write, same D-AR late-acceptance re-enable. Users with no
 * enablement row are untouched: no row means not enabled, so there is
 * nothing to suspend.
 */
@Injectable()
export class PluginUpdateService {
  private readonly logger = new Logger(PluginUpdateService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly authority: PluginGrantAuthorityService,
    private readonly staticAnalysis: PluginStaticAnalysisService,
    private readonly emitter: EventEmitter2,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  async stage(input: PluginUpdateStageInput): Promise<PluginUpdateStageResult> {
    const initiatedAt = new Date();
    const { directory, provenance } = input;

    if (provenance.bundled !== directory.bundled) {
      throw new PluginUpdateProvenanceMismatchError(
        directory.slug,
        `provenance says bundled=${provenance.bundled}, the directory resolved as bundled=${directory.bundled}`,
      );
    }

    if (!(await this.authority.isServerAdmin(input.initiatorId))) {
      throw new PluginUpdateAuthorityError(input.initiatorId);
    }

    const plugin = await this.loadUpdatablePlugin(directory.slug);

    // The row's `bundled` decides which root the loader resolves, so an
    // update may not change it: bundled ↔ sideloaded is a reinstall, not a
    // new version. Writing the column instead would point the row at a
    // version the resolved root does not contain.
    if (provenance.bundled !== plugin.bundled) {
      throw new PluginUpdateProvenanceMismatchError(
        directory.slug,
        `provenance says bundled=${provenance.bundled} but the installed plugin is bundled=${plugin.bundled} — ` +
          'changing distribution kind is a reinstall, not an update',
      );
    }

    const next = await this.validateNextManifest(directory, plugin);

    // Refuse rather than supersede (see PluginUpdatePendingConflictError):
    // checked after validation so a malformed incoming manifest is reported
    // as malformed rather than as a staging conflict. The authoritative
    // guard is the conditional write below — this one produces the better
    // error for the common, uncontended case.
    if (plugin.pendingVersion !== null) {
      throw new PluginUpdatePendingConflictError(plugin.slug, plugin.pendingVersion, next.manifest.version);
    }

    this.assertNoForbiddenPermissions(next);

    const corePermissions = await this.loadCorePermissions(next);
    const analysis = await this.staticAnalysis.analyze(directory, { deepScan: input.deepScan ?? false });
    const acknowledgedForbiddenImports = this.resolveAnalysisGate(
      directory.slug,
      analysis,
      input.acknowledgeForbiddenImports ?? [],
    );

    const active = this.validateActiveManifest(plugin);
    const comparison = await this.compare(plugin, active, next, corePermissions);

    // Immediate activation (D-AN): nothing server-gates and no denial
    // blocks. New household/user-scope permissions do not hold this path —
    // their consent is the units', expressed as suspension below.
    if (!comparison.serverGating && comparison.blockedByDenial.length === 0) {
      const outcome = await this.activate(
        plugin,
        active,
        next,
        provenance,
        comparison,
        [],
        corePermissions,
        input.initiatorId,
        initiatedAt,
      );
      this.emitActivation(plugin, outcome, next, [], initiatedAt);
      this.logger.log(
        `Plugin '${plugin.slug}' updated ${plugin.version} → ${next.manifest.version} without staged consent ` +
          `(no server-gating escalation); restart required to load the new code`,
      );

      return {
        plugin: outcome.plugin,
        activated: true,
        comparison,
        analysis,
        warnings: next.warnings,
        acknowledgedForbiddenImports,
        seededGrants: outcome.seededGrants,
      };
    }

    const staged = await this.db.$transaction(async (tx) => {
      // Conditional on `pendingVersion` still being null INSIDE the
      // transaction. The check above reads before the write, so two
      // concurrent stages could both see an empty slot and the loser would
      // silently overwrite the winner's staged version — exactly the
      // supersede this refusal exists to prevent.
      const claimed = await tx.plugin.updateMany({
        where: { id: plugin.id, pendingVersion: null },
        data: {
          pendingVersion: next.manifest.version,
          pendingManifestJson: next.manifest as Prisma.InputJsonValue,
          pendingSha256: provenance.bundled ? null : provenance.pendingSha256,
          pendingSince: initiatedAt,
        },
      });

      if (claimed.count !== 1) {
        const current = await tx.plugin.findUnique({
          where: { id: plugin.id },
          select: { pendingVersion: true },
        });

        throw new PluginUpdatePendingConflictError(
          plugin.slug,
          current?.pendingVersion ?? 'unknown',
          next.manifest.version,
        );
      }

      return tx.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
    });

    this.emitter.emit(
      PluginUpdatePendingEvent.eventName,
      new PluginUpdatePendingEvent(
        this.stagingSnapshot(plugin),
        this.stagingSnapshot(staged),
        staged.pendingSha256,
        comparison.escalations,
        acknowledgedForbiddenImports,
        initiatedAt,
      ),
    );
    this.logger.log(
      `Plugin '${plugin.slug}' update ${plugin.version} → ${next.manifest.version} staged pending consent: ` +
        `${comparison.escalations.length} escalation(s)` +
        (comparison.blockedByDenial.length > 0
          ? `, activation blocked by ${comparison.blockedByDenial.length} durable denial(s)`
          : ''),
    );

    return {
      plugin: staged,
      activated: false,
      comparison,
      analysis,
      warnings: next.warnings,
      acknowledgedForbiddenImports,
      seededGrants: [],
    };
  }

  async approve(input: PluginUpdateApproveInput): Promise<PluginUpdateApproveResult> {
    const initiatedAt = new Date();

    if (!(await this.authority.isServerAdmin(input.approverId))) {
      throw new PluginUpdateAuthorityError(input.approverId);
    }

    const plugin = await this.loadUpdatablePlugin(input.slug);

    if (plugin.pendingVersion === null || plugin.pendingManifestJson === null) {
      throw new PluginUpdateNoPendingError(plugin.slug);
    }

    // bgeCompat ENFORCED at activation, not just staging: BGE itself may
    // have moved between the two, and approving a version that can no
    // longer load would trade a typed refusal here for a quarantine at the
    // next boot.
    const next = this.validateStoredManifest(plugin, plugin.pendingManifestJson, plugin.pendingVersion, {
      enforceBgeCompat: true,
      label: 'pending',
    });
    const active = this.validateActiveManifest(plugin);
    const corePermissions = await this.loadCorePermissions(next);

    // Recomputed rather than replayed from staging: decisions can change
    // between stage and approve, and D-AB keys on the denials that survive
    // NOW.
    const comparison = await this.compare(plugin, active, next, corePermissions);

    if (comparison.blockedByDenial.length > 0) {
      throw new PluginUpdateBlockedByDenialError(plugin.slug, comparison.blockedByDenial);
    }

    // Approval IS the server-scope consent act for the update's NEW
    // server-consentable checks — seeded Granted, mirroring install (D-AA
    // posture). Checks with ANY existing row are left alone: a Granted row
    // is already consent, and a Denied row on an optional check is a
    // durable refusal this approval must not overwrite.
    const checksToSeed = await this.serverChecksToSeed(plugin, next);

    // The second factor tracks the authority this approval CONFERS, which is
    // the newly seeded checks plus any server-scope permission whose risk
    // rose since it was decided (D-X). Re-approving a Low permission that
    // became Critical hands over Critical authority just as surely as
    // granting it fresh, so it demands the same re-entry.
    const riskEscalatedChecks = next.permissionChecks.filter((check) =>
      comparison.serverRiskEscalatedSlugs.includes(check.canonicalSlug),
    );
    const expectedCritical = criticalConfirmationExpectation(
      [...checksToSeed, ...riskEscalatedChecks],
      corePermissions,
    );
    const reentry = compareExactReentry(expectedCritical, input.confirmCriticalSlugs ?? []);

    if (!reentry.exact) {
      throw new PluginUpdateCriticalConfirmationError(plugin.slug, reentry.expected, reentry.received);
    }

    const outcome = await this.activate(
      plugin,
      active,
      next,
      plugin.pendingSha256 === null ? { bundled: true } : { bundled: false, pendingSha256: plugin.pendingSha256 },
      comparison,
      checksToSeed,
      corePermissions,
      input.approverId,
      initiatedAt,
    );

    this.emitActivation(plugin, outcome, next, checksToSeed, initiatedAt);
    this.logger.log(
      `Plugin '${plugin.slug}' update approved: ${plugin.version} → ${next.manifest.version}, ` +
        `${outcome.seededGrants.length} server grant(s) seeded, ${outcome.reStampedGrants.length} re-stamped, ` +
        `${outcome.revokedGrants.length + outcome.scopeMovedGrants.length} revoked, ` +
        `${outcome.suspendedHouseholdUnits.length} household and ${outcome.suspendedUserUnits.length} user ` +
        `unit(s) suspended pending consent; restart required`,
    );

    return { plugin: outcome.plugin, comparison, seededGrants: outcome.seededGrants };
  }

  async reject(input: PluginUpdateRejectInput): Promise<Plugin> {
    const initiatedAt = new Date();

    if (!(await this.authority.isServerAdmin(input.rejectorId))) {
      throw new PluginUpdateAuthorityError(input.rejectorId);
    }

    const plugin = await this.loadUpdatablePlugin(input.slug);

    if (plugin.pendingVersion === null) {
      throw new PluginUpdateNoPendingError(plugin.slug);
    }

    const rejected = await this.db.plugin.update({
      where: { id: plugin.id },
      data: { pendingVersion: null, pendingManifestJson: Prisma.DbNull, pendingSha256: null, pendingSince: null },
    });

    // #84 seam: the staged version's on-disk files are the distribution
    // pipeline's to remove — this service never touches the filesystem
    // beyond reading manifests (D-Y).
    this.emitter.emit(
      PluginUpdateRejectedEvent.eventName,
      new PluginUpdateRejectedEvent(this.stagingSnapshot(plugin), this.stagingSnapshot(rejected), initiatedAt),
    );
    this.logger.log(`Plugin '${plugin.slug}' pending update ${plugin.pendingVersion} rejected and cleared`);

    return rejected;
  }

  /** D-AS predicate at the seam: a tombstoned row is not an update target, and the distinction deserves its own error. */
  private async loadUpdatablePlugin(slug: string): Promise<Plugin> {
    const plugin = await this.db.plugin.findUnique({ where: { slug } });

    if (plugin === null) {
      throw new PluginUpdatePluginNotFoundError(slug);
    }

    if (plugin.uninstalledAt !== null) {
      throw new PluginUpdateTombstonedError(slug, plugin.uninstalledAt);
    }

    return plugin;
  }

  private async validateNextManifest(
    directory: InstalledPluginDirectory,
    plugin: Plugin,
  ): Promise<PluginManifestValidationResult> {
    let raw: unknown;

    try {
      raw = JSON.parse(await readFile(directory.manifestPath, 'utf-8'));
    } catch (err) {
      throw new PluginUpdateManifestError(
        directory.slug,
        `manifest.json could not be read or parsed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const next = this.validate(raw, directory.slug, { enforceBgeCompat: true, label: 'new' });

    if (next.manifest.slug !== plugin.slug) {
      throw new PluginUpdateManifestError(
        directory.slug,
        `manifest slug '${next.manifest.slug}' does not match the installed plugin — updates replace in place, never rename`,
      );
    }

    if (next.manifest.version === plugin.version) {
      throw new PluginUpdateVersionConflictError(plugin.slug, plugin.version);
    }

    return next;
  }

  /**
   * The comparison baseline: the ACTIVE stored manifest, re-validated with
   * `enforceBgeCompat: false` — the same posture as consent-time
   * re-validation, and for the same reason: a BGE upgrade past the active
   * version's range must not make its own replacement un-stageable.
   */
  private validateActiveManifest(plugin: Plugin): PluginManifestValidationResult {
    const active = this.validateStoredManifest(plugin, plugin.manifestJson, plugin.version, {
      enforceBgeCompat: false,
      label: 'active',
    });

    return active;
  }

  private validateStoredManifest(
    plugin: Plugin,
    json: unknown,
    expectedVersion: string,
    context: { readonly enforceBgeCompat: boolean; readonly label: 'active' | 'pending' },
  ): PluginManifestValidationResult {
    const validated = this.validate(json, plugin.slug, context);

    if (validated.manifest.slug !== plugin.slug || validated.manifest.version !== expectedVersion) {
      throw new PluginUpdateManifestError(
        plugin.slug,
        `stored ${context.label} manifest identifies '${validated.manifest.slug}'@${validated.manifest.version} but the row ` +
          `says '${plugin.slug}'@${expectedVersion} — drifted state makes the escalation comparison meaningless`,
      );
    }

    return validated;
  }

  private validate(
    raw: unknown,
    slug: string,
    context: { readonly enforceBgeCompat: boolean; readonly label: string },
  ): PluginManifestValidationResult {
    try {
      return validatePluginManifest(raw, {
        bgeVersion: this.options.bgeVersion,
        defaultLocale: this.options.defaultLocale,
        enforceBgeCompat: context.enforceBgeCompat,
      });
    } catch (err) {
      if (err instanceof PluginManifestValidationError) {
        throw new PluginUpdateManifestError(slug, `${context.label} manifest failed validation`, err.issues);
      }

      throw err;
    }
  }

  private assertNoForbiddenPermissions(next: PluginManifestValidationResult): void {
    const [violation] = collectForbiddenPermissionViolations(next);

    if (violation !== undefined) {
      throw new PluginUpdateForbiddenPermissionError(next.manifest.slug, violation.permissionSlug, violation.detail);
    }
  }

  private async loadCorePermissions(next: PluginManifestValidationResult): Promise<ReadonlyMap<string, Permission>> {
    const slugs = next.externalPermissionChecks;
    const rows = slugs.length === 0 ? [] : await this.db.permission.findMany({ where: { slug: { in: [...slugs] } } });
    const bySlug = new Map(rows.map((row) => [row.slug, row]));
    const missing = slugs.filter((slug) => !bySlug.has(slug));

    if (missing.length > 0) {
      throw new PluginUpdateUnknownCorePermissionError(next.manifest.slug, missing);
    }

    const [wildcard] = collectWildcardSubjectViolations(next, bySlug);

    if (wildcard !== undefined) {
      throw new PluginUpdateForbiddenPermissionError(next.manifest.slug, wildcard.permissionSlug, wildcard.detail);
    }

    return bySlug;
  }

  private resolveAnalysisGate(
    slug: string,
    analysis: StaticAnalysisReport,
    acknowledged: readonly string[],
  ): readonly string[] {
    const gating = gatingFindings(analysis);
    const resolution = resolveForbiddenSpecifierAcknowledgement(gating, acknowledged);

    if (resolution.unexpected.length > 0) {
      throw new PluginUpdateStaticAnalysisError(slug, gating, resolution.unacknowledged, resolution.unexpected);
    }

    if (resolution.unacknowledged.length > 0) {
      throw new PluginUpdateStaticAnalysisError(slug, gating, resolution.unacknowledged);
    }

    if (resolution.reported.length > 0) {
      this.logger.warn(
        `Plugin '${slug}' update proceeding with ${resolution.reported.length} forbidden import(s) explicitly ` +
          `accepted by the staging admin: ${resolution.reported.join(', ')}. The acceptance is recorded on the update event.`,
      );
    }

    return resolution.reported;
  }

  private async compare(
    plugin: Plugin,
    active: PluginManifestValidationResult,
    next: PluginManifestValidationResult,
    corePermissions: ReadonlyMap<string, Permission>,
  ): Promise<UpdateEscalationComparison> {
    const grants = await this.db.pluginGrant.findMany({ where: { pluginId: plugin.id } });
    const currentRiskBySlug = this.currentRiskBySlug(next, corePermissions);

    return compareForEscalations({
      active: this.comparisonView(active),
      next: this.comparisonView(next),
      grants: grants.map((grant) => ({
        permissionSlug: grant.permissionSlug,
        scopeType: grant.scopeType,
        status: grant.status,
        decidedRiskLevel: grant.decidedRiskLevel,
      })),
      currentRiskBySlug,
    });
  }

  /**
   * TODAY's catalog risk per requested slug. Plugin-declared rows are locked
   * to an explicit Low (D-W) and can never risk-escalate; core risk is the
   * current classification.
   */
  private currentRiskBySlug(
    next: PluginManifestValidationResult,
    corePermissions: ReadonlyMap<string, Permission>,
  ): ReadonlyMap<string, RiskLevel> {
    const bySlug = new Map<string, RiskLevel>();

    for (const check of next.permissionChecks) {
      bySlug.set(
        check.canonicalSlug,
        check.origin === 'plugin'
          ? RiskLevel.Low
          : (corePermissions.get(check.canonicalSlug)?.riskLevel ?? RiskLevel.Low),
      );
    }

    return bySlug;
  }

  private comparisonView(validated: PluginManifestValidationResult): ManifestComparisonView {
    return {
      outboundDomains: validated.manifest.network.outboundDomains,
      writesCore: validated.manifest.storage.writesCore,
      checks: validated.permissionChecks.map((check) => ({
        canonicalSlug: check.canonicalSlug,
        consentScope: check.consentScope,
        required: check.required,
      })),
    };
  }

  private async serverChecksToSeed(
    plugin: Plugin,
    next: PluginManifestValidationResult,
  ): Promise<readonly NormalizedPermissionRequest[]> {
    const serverChecks = next.permissionChecks.filter((check) => check.consentScope === 'server');

    if (serverChecks.length === 0) {
      return [];
    }

    const existing = await this.db.pluginGrant.findMany({
      where: {
        pluginId: plugin.id,
        scopeType: PluginGrantScope.Server,
        permissionSlug: { in: serverChecks.map((check) => check.canonicalSlug) },
      },
      select: { permissionSlug: true },
    });
    const decided = new Set(existing.map((row) => row.permissionSlug));

    return serverChecks.filter((check) => !decided.has(check.canonicalSlug));
  }

  /**
   * The activation transaction, shared by the immediate path and
   * `approve()`: promote the pending state, apply the D-AF `declares[]`
   * catalog diff (insert added rows, revoke and delete grants on removed
   * declares with `'permission-removed'` provenance, delete the rows),
   * seed the approval's server grants, suspend household AND user units
   * lacking consent on their scope's re-consent escalations (D-AO, #225),
   * and set `restartRequired` (D-AT). Events are collected inside and
   * emitted by the caller AFTER commit.
   */
  private async activate(
    plugin: Plugin,
    active: PluginManifestValidationResult,
    next: PluginManifestValidationResult,
    provenance: PluginUpdateProvenance,
    comparison: UpdateEscalationComparison,
    checksToSeed: readonly NormalizedPermissionRequest[],
    corePermissions: ReadonlyMap<string, Permission>,
    actorId: string,
    initiatedAt: Date,
  ): Promise<ActivationOutcome> {
    return this.db.$transaction(async (tx) => {
      const activeDeclares = new Set(active.declaredPermissions.map((declared) => declared.canonicalSlug));
      const nextDeclares = new Set(next.declaredPermissions.map((declared) => declared.canonicalSlug));
      const addedDeclares = [...nextDeclares].filter((slug) => !activeDeclares.has(slug));
      const removedDeclares = [...activeDeclares].filter((slug) => !nextDeclares.has(slug));

      // D-AF: grants on removed declares are deleted with
      // 'permission-removed' provenance — collected BEFORE deletion because
      // the revocation events are the only durable record of what lapsed.
      let revokedGrants: PluginGrant[] = [];

      if (removedDeclares.length > 0) {
        revokedGrants = await tx.pluginGrant.findMany({
          where: { pluginId: plugin.id, permissionSlug: { in: removedDeclares } },
        });
        await tx.pluginGrant.deleteMany({ where: { pluginId: plugin.id, permissionSlug: { in: removedDeclares } } });
        await tx.pluginPermission.deleteMany({ where: { pluginId: plugin.id, slug: { in: removedDeclares } } });
      }

      for (const slug of addedDeclares) {
        await tx.pluginPermission.create({
          // Explicit Low, never the manifest and never a schema default (D-W).
          data: { pluginId: plugin.id, slug, riskLevel: RiskLevel.Low },
        });
      }

      // D-X re-stamp: approval is the consent act for a server-scope risk
      // escalation, so the row records TODAY's risk and this version. Without
      // it the stale baseline re-fires the same escalation on every future
      // update and the Critical second factor never sees the reclassification.
      const reStampedGrants: PluginGrant[] = [];

      for (const slug of comparison.serverRiskEscalatedSlugs) {
        reStampedGrants.push(
          await tx.pluginGrant.update({
            where: {
              pluginId_scopeType_scopeId_permissionSlug: {
                pluginId: plugin.id,
                scopeType: PluginGrantScope.Server,
                scopeId: SERVER_SCOPE_SENTINEL,
                permissionSlug: slug,
              },
            },
            data: {
              decidedRiskLevel: corePermissions.get(slug)?.riskLevel ?? RiskLevel.Low,
              decidedById: actorId,
              decidedAt: initiatedAt,
              manifestVersion: next.manifest.version,
            },
          }),
        );
      }

      // A permission that moved consent scope leaves a decision made by a
      // principal that no longer owns it. The old-scope rows are deleted
      // (delete-to-pending) so the new scope's consent surface starts clean.
      const scopeMoves = comparison.escalations.filter(
        (escalation): escalation is Extract<UpdateEscalation, { kind: 'consent-scope-changed' }> =>
          escalation.kind === 'consent-scope-changed',
      );
      const scopeMovedGrants: PluginGrant[] = [];

      for (const move of scopeMoves) {
        const stale = await tx.pluginGrant.findMany({
          where: {
            pluginId: plugin.id,
            permissionSlug: move.slug,
            scopeType: CONSENT_SCOPE_TO_GRANT_SCOPE[move.from],
          },
        });

        if (stale.length === 0) {
          continue;
        }

        await tx.pluginGrant.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
        scopeMovedGrants.push(...stale);
      }

      const seededGrants: PluginGrant[] = [];

      for (const check of checksToSeed) {
        seededGrants.push(
          await tx.pluginGrant.create({
            data: {
              pluginId: plugin.id,
              scopeType: PluginGrantScope.Server,
              scopeId: SERVER_SCOPE_SENTINEL,
              permissionSlug: check.canonicalSlug,
              status: PluginGrantStatus.Granted,
              manifestVersion: next.manifest.version,
              decidedById: actorId,
              decidedAt: initiatedAt,
              decidedRiskLevel:
                check.origin === 'plugin'
                  ? RiskLevel.Low
                  : (corePermissions.get(check.canonicalSlug)?.riskLevel ?? RiskLevel.Low),
            },
          }),
        );
      }

      const updated = await tx.plugin.update({
        where: { id: plugin.id },
        data: {
          version: next.manifest.version,
          // Row identity columns follow the manifest they mirror — a version
          // may legitimately re-categorize or re-scope. `executionMode` is
          // deliberately NOT refreshed: the manifest value is an install-time
          // hint and the column is admin-owned after that (#197).
          category: MANIFEST_CATEGORY_TO_PRISMA[next.manifest.category],
          scope: MANIFEST_SCOPE_TO_PRISMA[next.manifest.scope],
          manifestJson: next.manifest as Prisma.InputJsonValue,
          ...(provenance.bundled ? {} : { installedSha256: provenance.pendingSha256 }),
          pendingVersion: null,
          pendingManifestJson: Prisma.DbNull,
          pendingSha256: null,
          pendingSince: null,
          // D-AT: the running instance is still the prior code; the loader
          // clears this on the boot that actually loads the new version.
          restartRequired: true,
        },
      });

      // TODAY's risk per requested slug, shared by both suspension passes:
      // the covering test must read one classification or the two scopes
      // could disagree about the same slug.
      const currentRisk = this.currentRiskBySlug(next, corePermissions);

      // Fixed query count regardless of how many units run the plugin: one
      // unit read, one grant read, one write per scope. A per-unit loop put
      // this transaction's duration on the number of installs, and exceeding
      // the interactive-transaction timeout would roll back the whole
      // update — failing an activation because the plugin was POPULAR.
      let suspendedHouseholdUnits: SuspensionCandidate<HouseholdPlugin>[] = [];

      if (comparison.householdReconsentSlugs.length > 0) {
        const units = await tx.householdPlugin.findMany({
          where: { pluginId: plugin.id, suspendedForConsent: false },
        });

        if (units.length > 0) {
          const granted = await tx.pluginGrant.findMany({
            where: {
              pluginId: plugin.id,
              scopeType: PluginGrantScope.Household,
              scopeId: { in: units.map((unit) => unit.householdId) },
              status: PluginGrantStatus.Granted,
              permissionSlug: { in: [...comparison.householdReconsentSlugs] },
            },
            // decidedRiskLevel is load-bearing, not decoration: for a D-X
            // escalation the Granted row EXISTS by definition — its stale
            // risk is what escalated — so treating presence as consent would
            // silently skip every risk-escalated unit.
            select: { scopeId: true, permissionSlug: true, decidedRiskLevel: true },
          });

          const candidates = this.suspensionCandidates({
            units,
            scopeIdOf: (unit) => unit.householdId,
            suspend: (unit) => ({ ...unit, suspendedForConsent: true, suspendedAt: initiatedAt }),
            granted,
            reconsentSlugs: comparison.householdReconsentSlugs,
            currentRisk,
          });

          suspendedHouseholdUnits = await this.applySuspension(
            candidates,
            (ids) =>
              tx.householdPlugin.updateMany({
                where: { id: { in: [...ids] }, suspendedForConsent: false },
                data: { suspendedForConsent: true, suspendedAt: initiatedAt },
              }),
            (ids) =>
              tx.householdPlugin.findMany({
                where: { id: { in: [...ids] }, suspendedAt: initiatedAt },
                select: { id: true },
              }),
          );
        }
      }

      // The user-scope mirror (#225): identical shape against `UserPlugin`.
      // Users with no enablement row never appear in the unit read — no row
      // means not enabled, so there is nothing to suspend.
      let suspendedUserUnits: SuspensionCandidate<UserPlugin>[] = [];

      if (comparison.userReconsentSlugs.length > 0) {
        const units = await tx.userPlugin.findMany({
          where: { pluginId: plugin.id, suspendedForConsent: false },
        });

        if (units.length > 0) {
          const granted = await tx.pluginGrant.findMany({
            where: {
              pluginId: plugin.id,
              scopeType: PluginGrantScope.User,
              scopeId: { in: units.map((unit) => unit.userId) },
              status: PluginGrantStatus.Granted,
              permissionSlug: { in: [...comparison.userReconsentSlugs] },
            },
            select: { scopeId: true, permissionSlug: true, decidedRiskLevel: true },
          });

          const candidates = this.suspensionCandidates({
            units,
            scopeIdOf: (unit) => unit.userId,
            suspend: (unit) => ({ ...unit, suspendedForConsent: true, suspendedAt: initiatedAt }),
            granted,
            reconsentSlugs: comparison.userReconsentSlugs,
            currentRisk,
          });

          suspendedUserUnits = await this.applySuspension(
            candidates,
            (ids) =>
              tx.userPlugin.updateMany({
                where: { id: { in: [...ids] }, suspendedForConsent: false },
                data: { suspendedForConsent: true, suspendedAt: initiatedAt },
              }),
            (ids) =>
              tx.userPlugin.findMany({
                where: { id: { in: [...ids] }, suspendedAt: initiatedAt },
                select: { id: true },
              }),
          );
        }
      }

      return {
        plugin: updated,
        seededGrants,
        revokedGrants,
        scopeMovedGrants,
        reStampedGrants,
        suspendedHouseholdUnits,
        suspendedUserUnits,
      };
    });
  }

  /** Post-commit emissions, matching the commit-then-emit discipline everywhere else. */
  private emitActivation(
    before: Plugin,
    outcome: ActivationOutcome,
    next: PluginManifestValidationResult,
    seededChecks: readonly NormalizedPermissionRequest[],
    initiatedAt: Date,
  ): void {
    const grantedPermissions: GrantedPermissionRecord[] = seededChecks.map((check) => ({
      slug: check.canonicalSlug,
      required: check.required,
      consentScope: check.consentScope,
      reason: resolveLocalizedString(check.reason, {
        locale: this.options.defaultLocale,
        defaultLocale: this.options.defaultLocale,
      }),
    }));

    this.emitter.emit(
      PluginUpdateApprovedEvent.eventName,
      new PluginUpdateApprovedEvent(
        this.stagingSnapshot(before),
        this.stagingSnapshot(outcome.plugin),
        grantedPermissions,
        initiatedAt,
      ),
    );

    const revocations: readonly { grant: PluginGrant; reason: PluginGrantRevocationReason }[] = [
      ...outcome.revokedGrants.map((grant) => ({ grant, reason: 'permission-removed' as const })),
      ...outcome.scopeMovedGrants.map((grant) => ({ grant, reason: 'consent-scope-changed' as const })),
    ];

    for (const { grant, reason } of revocations) {
      const { id, pluginId, scopeType, scopeId, permissionSlug, status, manifestVersion, decidedRiskLevel } = grant;

      this.emitter.emit(
        PluginGrantRevokedEvent.eventName,
        new PluginGrantRevokedEvent(
          { id, pluginId, scopeType, scopeId, permissionSlug, status, manifestVersion, decidedRiskLevel },
          reason,
          initiatedAt,
        ),
      );
    }

    for (const unit of outcome.suspendedHouseholdUnits) {
      this.emitter.emit(
        HouseholdPluginUnitDisabledEvent.eventName,
        new HouseholdPluginUnitDisabledEvent(
          this.householdUnitSnapshot(unit.before),
          this.householdUnitSnapshot(unit.after),
          unit.outstanding,
          next.manifest.version,
          initiatedAt,
        ),
      );
    }

    for (const unit of outcome.suspendedUserUnits) {
      this.emitter.emit(
        UserPluginUnitDisabledEvent.eventName,
        new UserPluginUnitDisabledEvent(
          this.userUnitSnapshot(unit.before),
          this.userUnitSnapshot(unit.after),
          unit.outstanding,
          next.manifest.version,
          initiatedAt,
        ),
      );
    }
  }

  /**
   * Which units of one scope owe a fresh decision under this activation —
   * the pure half of the suspension pass, shared by the household and user
   * blocks in `activate()` so the covering predicate cannot drift between
   * scopes. A slug is outstanding unless the unit has a Granted row AND the
   * risk it consented under still covers today's classification (D-X).
   */
  private suspensionCandidates<TUnit>(args: {
    readonly units: readonly TUnit[];
    readonly scopeIdOf: (unit: TUnit) => string;
    /** Constructed, not read back — the write sets exactly the suspension fields; `enabled` intent is untouched (D-AO). */
    readonly suspend: (unit: TUnit) => TUnit;
    readonly granted: readonly {
      readonly scopeId: string;
      readonly permissionSlug: string;
      readonly decidedRiskLevel: RiskLevel;
    }[];
    readonly reconsentSlugs: readonly string[];
    readonly currentRisk: ReadonlyMap<string, RiskLevel>;
  }): SuspensionCandidate<TUnit>[] {
    const decidedByUnit = new Map<string, Map<string, RiskLevel>>();

    for (const row of args.granted) {
      const slugs = decidedByUnit.get(row.scopeId) ?? new Map<string, RiskLevel>();
      slugs.set(row.permissionSlug, row.decidedRiskLevel);
      decidedByUnit.set(row.scopeId, slugs);
    }

    const candidates: SuspensionCandidate<TUnit>[] = [];

    for (const unit of args.units) {
      const decided = decidedByUnit.get(args.scopeIdOf(unit)) ?? new Map<string, RiskLevel>();
      const outstanding = args.reconsentSlugs.filter((slug) => {
        const decidedRiskLevel = decided.get(slug);

        return (
          decidedRiskLevel === undefined || !riskCovers(decidedRiskLevel, args.currentRisk.get(slug) ?? RiskLevel.Low)
        );
      });

      if (outstanding.length > 0) {
        candidates.push({ before: unit, after: args.suspend(unit), outstanding });
      }
    }

    return candidates;
  }

  /**
   * Guarded suspension write + survivor read-back, shared by both scopes.
   * The write is guarded on `suspendedForConsent: false`, so a concurrent
   * writer can suspend a row between the candidate read and this statement.
   * On a count mismatch, read back which rows THIS statement flipped —
   * emitting a suspension event for a transition that did not occur would
   * put a lifecycle row on the timeline claiming this activation suspended
   * a unit it never touched. Same shape as revokeForAuthorityLoss's
   * survivor read-back.
   */
  private async applySuspension<TUnit extends { readonly id: string }>(
    candidates: readonly SuspensionCandidate<TUnit>[],
    write: (ids: readonly string[]) => Promise<{ count: number }>,
    readBackFlipped: (ids: readonly string[]) => Promise<readonly { readonly id: string }[]>,
  ): Promise<SuspensionCandidate<TUnit>[]> {
    if (candidates.length === 0) {
      return [];
    }

    const ids = candidates.map((entry) => entry.before.id);
    const written = await write(ids);

    if (written.count === candidates.length) {
      return [...candidates];
    }

    const flipped = await readBackFlipped(ids);
    const flippedIds = new Set(flipped.map((row) => row.id));

    return candidates.filter((entry) => flippedIds.has(entry.before.id));
  }

  private stagingSnapshot(plugin: Plugin) {
    const { id, slug, version, pendingVersion } = plugin;

    return { id, slug, version, pendingVersion };
  }

  private householdUnitSnapshot(unit: HouseholdPlugin) {
    const { id, householdId, pluginId, enabled, suspendedForConsent } = unit;

    return { id, householdId, pluginId, enabled, suspendedForConsent };
  }

  private userUnitSnapshot(unit: UserPlugin) {
    const { id, userId, pluginId, enabled, suspendedForConsent } = unit;

    return { id, userId, pluginId, enabled, suspendedForConsent };
  }
}
