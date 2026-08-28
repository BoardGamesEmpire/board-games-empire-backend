import {
  constraintIdentity,
  DatabaseService,
  identifiesConstraint,
  isDeadlockError,
  PluginGrantScope,
  PluginGrantStatus,
  Prisma,
  riskCovers,
  RiskLevel,
  SERVER_SCOPE_SENTINEL,
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
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import { retainedServerConfig } from '../config/retained-server-config';
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
import { CONSENT_SCOPE_TO_GRANT_SCOPE } from '../grants/consent-scope.map';
import { PluginGrantAuthorityService } from '../grants/plugin-grant-authority.service';
import {
  collectForbiddenPermissionViolations,
  collectUnboundedUnitConsentViolations,
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
import {
  emitHouseholdDormancy,
  reconcileHouseholdDormancy,
  type HouseholdDormancyTransition,
} from '../units/household-dormancy';
import { compareForEscalations } from './escalation-comparator';
import { CLEARED_STAGED_UPDATE } from './staged-update.columns';
import type { ManifestComparisonView, UpdateEscalation, UpdateEscalationComparison } from './update-escalation.types';
import {
  PluginUpdateAuthorityError,
  PluginUpdateBlockedByDenialError,
  PluginUpdateCriticalConfirmationError,
  PluginUpdateForbiddenPermissionError,
  PluginUpdateManifestError,
  PluginUpdateManifestSource,
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
 * `PluginGrant`'s decision unique, in every spelling `constraintIdentity` can
 * report it: raw columns from the driver adapter (the shape that ships), and
 * Prisma field names in case a release restores `meta.target`.
 */
const GRANT_DECISION_UNIQUE_COLUMNS = ['plugin_id', 'scope_type', 'scope_id', 'permission_slug'] as const;
const GRANT_DECISION_UNIQUE_FIELDS = ['pluginId', 'scopeType', 'scopeId', 'permissionSlug'] as const;

/**
 * True when a failure is a grant-decision collision — the only failure the
 * activation transaction retries.
 *
 * An unidentifiable P2002 answers FALSE. `constraintIdentity` cannot tell
 * "not that constraint" from "could not tell", and the safe reading here is
 * the second: retrying a violation this transaction cannot explain would
 * replay a deterministic write that fails identically, turning one honest
 * error into the same error, later.
 */
function isGrantDecisionCollision(error: unknown): boolean {
  return identifiesConstraint(constraintIdentity(error), GRANT_DECISION_UNIQUE_COLUMNS, GRANT_DECISION_UNIQUE_FIELDS);
}

/**
 * The `declares[]` catalog diff, shared by the read that RENDERS it and the
 * transaction that APPLIES it. One function because the screen showing
 * "approving deletes these permissions" and the code deleting them must not
 * be able to disagree — the same reason the two paths share one comparison.
 */
function declaredSlugDiff(
  active: PluginManifestValidationResult,
  next: PluginManifestValidationResult,
): PluginUpdateDeclaresDiff {
  const activeDeclares = new Set(active.declaredPermissions.map((declared) => declared.canonicalSlug));
  const nextDeclares = new Set(next.declaredPermissions.map((declared) => declared.canonicalSlug));

  return {
    added: [...nextDeclares].filter((slug) => !activeDeclares.has(slug)),
    removed: [...activeDeclares].filter((slug) => !nextDeclares.has(slug)),
  };
}

/**
 * Typed update provenance, mirroring install's shape: `bundled = false
 * ⇒ pendingSha256` is unrepresentable-when-violated. URL/registry
 * provenance columns keep describing the INSTALL; #84 extends this when its
 * ingress metadata needs to ride an update.
 */
export type PluginUpdateProvenance =
  | { readonly bundled: true }
  | { readonly bundled: false; readonly pendingSha256: string };

export interface PluginUpdateStageInput {
  /** The NEW version's resolved directory — placed by #84 (or the bundled resolver); this service never touches a tarball (#59). */
  readonly directory: InstalledPluginDirectory;
  readonly provenance: PluginUpdateProvenance;
  /** The staging admin — server-admin authority is verified, never assumed, exactly as install verifies it. */
  readonly initiatorId: string;
  /** Admin opt-in: extend static analysis into node_modules; findings advisory only. */
  readonly deepScan?: boolean;
  /** Exact re-entry of every forbidden import specifier analysis reported on the NEW version — the same acknowledgement install demands. */
  readonly acknowledgeForbiddenImports?: readonly string[];
}

export interface PluginUpdateStageResult {
  readonly plugin: Plugin;
  /** True when no server-gating escalation existed and the update activated immediately. */
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
  /** Exact re-entry of every Critical permission slug this approval will GRANT — the same second factor install demands (#59). */
  readonly confirmCriticalSlugs?: readonly string[];
}

/** One household unit an approval suspended, with the slugs that unit must decide before it serves again (#321). */
export interface PluginUpdateSuspendedHouseholdUnit {
  readonly householdId: string;
  readonly outstanding: readonly string[];
}

/** One user unit an approval suspended — the household shape's user-axis mirror (#225). */
export interface PluginUpdateSuspendedUserUnit {
  readonly userId: string;
  readonly outstanding: readonly string[];
}

export interface PluginUpdateApproveResult {
  readonly plugin: Plugin;
  readonly comparison: UpdateEscalationComparison;
  /** Server-scope grants seeded by this approval — the new server-consentable checks. */
  readonly seededGrants: readonly PluginGrant[];
  /**
   * Units THIS approval suspended pending re-consent, per axis (#321):
   * the admin who approved needs the consequence synchronously, and the
   * activation transaction already knows the exact set — the events carry
   * the same units, but an event stream is not a response body.
   */
  readonly suspendedHouseholdUnits: readonly PluginUpdateSuspendedHouseholdUnit[];
  readonly suspendedUserUnits: readonly PluginUpdateSuspendedUserUnit[];
}

export interface PluginUpdateRejectInput {
  readonly slug: string;
  readonly rejectorId: string;
}

/**
 * The `declares[]` catalog diff between the active and pending manifests:
 * the plugin-namespaced permissions activation will INSERT into the catalog,
 * and the ones it will delete — taking their grants with them.
 *
 * Not derivable from `checks[]` or from the escalations: a declaration the
 * plugin never requests still appears in the catalog, and no escalation kind
 * describes a declaration change. The approval screen needs it because
 * `removed` is the destructive half of approving.
 */
export interface PluginUpdateDeclaresDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/**
 * What the pending-update read returns (#321): the row, when the
 * update was staged, the `declares[]` diff activation would apply, and the
 * escalation comparison RECOMPUTED against today's decisions — never
 * replayed from staging, mirroring `approve()`'s posture, so the approval
 * screen and the approval itself cannot disagree.
 */
export interface PluginUpdatePendingDescription {
  readonly plugin: Plugin;
  readonly comparison: UpdateEscalationComparison;
  /** `Plugin.pendingSince` verbatim — nullable because the column is; every staging write this service makes sets it. */
  readonly pendingSince: Date | null;
  readonly declares: PluginUpdateDeclaresDiff;
}

/** One unit activation decided to suspend, with the slugs that forced it. */
interface SuspensionCandidate<TUnit> {
  readonly before: TUnit;
  readonly after: TUnit;
  readonly outstanding: readonly string[];
}

interface ActivationOutcome {
  readonly plugin: Plugin;
  /** The checks actually seeded — the caller's set re-filtered against the tx-local decisions (see `activate()`). */
  readonly seededChecks: readonly NormalizedPermissionRequest[];
  readonly seededGrants: readonly PluginGrant[];
  readonly revokedGrants: readonly PluginGrant[];
  /** Grants deleted because their permission moved consent scope. */
  readonly scopeMovedGrants: readonly PluginGrant[];
  /** Server-scope grants whose `decidedRiskLevel` this approval refreshed (#59). */
  readonly reStampedGrants: readonly PluginGrant[];
  readonly suspendedHouseholdUnits: readonly SuspensionCandidate<HouseholdPlugin>[];
  /** User units suspended pending re-consent — the household pass's exact user-scope mirror (#225). */
  readonly suspendedUserUnits: readonly SuspensionCandidate<UserPlugin>[];
  /** Household rows whose dormancy this activation wrote or lifted (#369, D-CK). */
  readonly dormancyTransitions: readonly HouseholdDormancyTransition[];
  /**
   * Server config found invalid under the manifest this activation is
   * promoting and reset to `{}` (D-CN on #59/#370) — the same rule a
   * reinstall-over-tombstone applies via `retainedServerConfig`, ridden along
   * here so activation is not the one manifest-replacing path that leaves
   * `Plugin.config` unchecked.
   */
  readonly retainedConfigReset: boolean;
}

/**
 * The update consent seam (#59 Phase C3): the DB/consent half of a
 * plugin update. #84's distribution pipeline wraps `stage()` exactly as it
 * wraps `install()` — ingress, SHA-256 verification, extraction, and disk
 * placement of the new version stay there, as does removing a rejected
 * version's staged files.
 *
 * `stage()` validates the new manifest (with `bgeCompat` ENFORCED — a
 * version that cannot load must not be activatable), screens it through the
 * SAME consent gates as install (categorical exclusions, core-permission
 * existence, static analysis with its overridable forbidden-specifier
 * gate), runs the escalation comparison against the ACTIVE manifest, and
 * then either activates immediately (no server-gating escalation, no
 * denial block) or writes the pending columns and emits
 * `plugin.update_pending` for the admin surface.
 *
 * ACTIVATION never hot-swaps running code: the transaction promotes
 * the DB state — version, manifest, the `declares[]` catalog diff with
 * `'permission-removed'` grant revocation, per-unit suspension for
 * required-at-household-scope escalations — and sets
 * `restartRequired`; the running instance continues on the prior code until
 * the next boot, where the loader clears the flag. No forced restart:
 * updating several plugins in one sitting must not bounce the server N
 * times. A real teardown path arrives with #197's worker mode.
 *
 * User-scope escalations suspend `UserPlugin` units exactly as household
 * escalations suspend `HouseholdPlugin` units (#225) — same batched shape,
 * same guarded write, same late-acceptance re-enable. Users with no
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
    private readonly configSchema: PluginConfigSchemaService,
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

    // Immediate activation: nothing server-gates and no denial
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
      this.emitActivation(plugin, outcome, next, initiatedAt);
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
      // supersede this refusal exists to prevent. `uninstalledAt` rides the
      // same guard: uninstall clears these columns, and re-arming them
      // afterwards would report a staged update against a tombstone.
      const claimed = await tx.plugin.updateMany({
        where: { id: plugin.id, pendingVersion: null, uninstalledAt: null },
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
          select: { pendingVersion: true, uninstalledAt: true },
        });

        if (current?.uninstalledAt != null) {
          throw new PluginUpdateTombstonedError(plugin.slug, current.uninstalledAt);
        }

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

    const { plugin, active, next, corePermissions, comparison } = await this.resolvePendingUpdate(input.slug);

    if (comparison.blockedByDenial.length > 0) {
      throw new PluginUpdateBlockedByDenialError(plugin.slug, comparison.blockedByDenial);
    }

    // Approval IS the server-scope consent act for the update's NEW
    // server-consentable checks — seeded Granted, mirroring install's
    // posture. Checks with ANY existing row are left alone: a Granted row
    // is already consent, and a Denied row on an optional check is a
    // durable refusal this approval must not overwrite.
    const checksToSeed = await this.serverChecksToSeed(plugin, next);

    // The second factor tracks the authority this approval CONFERS, which is
    // the newly seeded checks plus any server-scope permission whose risk
    // rose since it was decided (#59). Re-approving a Low permission that
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
      { confirmCriticalSlugs: input.confirmCriticalSlugs ?? [], riskEscalatedChecks },
    );

    // The tx-local seeded set, not the pre-transaction one: a concurrent
    // decision may have shrunk it, and the event must describe what was
    // actually granted.
    this.emitActivation(plugin, outcome, next, initiatedAt);
    this.logger.log(
      `Plugin '${plugin.slug}' update approved: ${plugin.version} → ${next.manifest.version}, ` +
        `${outcome.seededGrants.length} server grant(s) seeded, ${outcome.reStampedGrants.length} re-stamped, ` +
        `${outcome.revokedGrants.length + outcome.scopeMovedGrants.length} revoked, ` +
        `${outcome.suspendedHouseholdUnits.length} household and ${outcome.suspendedUserUnits.length} user ` +
        `unit(s) suspended pending consent; restart required`,
    );

    return {
      plugin: outcome.plugin,
      comparison,
      seededGrants: outcome.seededGrants,
      // The post-write candidate lists — applySuspension already dropped
      // any unit a concurrent writer flipped first, so these report what
      // THIS approval did, exactly as the events do.
      suspendedHouseholdUnits: outcome.suspendedHouseholdUnits.map((unit) => ({
        householdId: unit.before.householdId,
        outstanding: unit.outstanding,
      })),
      suspendedUserUnits: outcome.suspendedUserUnits.map((unit) => ({
        userId: unit.before.userId,
        outstanding: unit.outstanding,
      })),
    };
  }

  /**
   * The approval screen's data source (#321): the pending update resolved
   * and compared exactly as `approve()` resolves it — literally the same
   * pipeline, via {@link resolvePendingUpdate} — so the screen and the
   * approval cannot disagree about what the update escalates.
   *
   * A pure read with two deliberate asymmetries from `approve()`: no
   * server-admin re-verification (reading is not a consent act — the edge
   * guards it with `read:plugin`), and a durable denial is RENDERED as
   * `comparison.blockedByDenial` rather than thrown — the screen's job is
   * to show the block, the approval's job is to refuse over it.
   */
  async describePending(slug: string): Promise<PluginUpdatePendingDescription> {
    const { plugin, active, next, comparison } = await this.resolvePendingUpdate(slug);

    return {
      plugin,
      comparison,
      pendingSince: plugin.pendingSince,
      declares: declaredSlugDiff(active, next),
    };
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

    // Conditional on the EXACT staging the rejector saw, like every other
    // staged-update writer: an unconditional clear racing an approve would
    // report "rejected" for an update that in fact activated — and emit the
    // update_rejected event #84 keys staged-file cleanup off, against files
    // that just became the active version's code. Racing a replacement
    // stage, it would wipe a staged version nobody decided on — and because
    // a rejected version can be re-staged under the SAME number (only the
    // ACTIVE version is refused), the version is not identity enough:
    // pendingSince, written fresh by every staging, is what pins the
    // staging this rejection targets.
    const rejected = await this.db.$transaction(async (tx) => {
      const cleared = await tx.plugin.updateMany({
        where: {
          id: plugin.id,
          pendingVersion: plugin.pendingVersion,
          pendingSince: plugin.pendingSince,
          uninstalledAt: null,
        },
        data: CLEARED_STAGED_UPDATE,
      });

      if (cleared.count !== 1) {
        const current = await tx.plugin.findUnique({
          where: { id: plugin.id },
          select: { uninstalledAt: true },
        });

        if (current?.uninstalledAt != null) {
          throw new PluginUpdateTombstonedError(plugin.slug, current.uninstalledAt);
        }

        throw new PluginUpdateNoPendingError(plugin.slug);
      }

      // Read back INSIDE the claim, like the staging and activation writes.
      // The clear leaves `pendingVersion` null, which is exactly the slot
      // stage() claims on, so an outside read-back can observe a NEWLY
      // staged version — handing this response, and the rejected event's
      // `after` snapshot that #84 keys staged-file cleanup off, a pending
      // update nobody rejected. The atomic single-statement update this
      // replaced could not express that state; the guarded updateMany can.
      return tx.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
    });

    // #84 seam: the staged version's on-disk files are the distribution
    // pipeline's to remove — this service never touches the filesystem
    // beyond reading manifests (#59).
    this.emitter.emit(
      PluginUpdateRejectedEvent.eventName,
      new PluginUpdateRejectedEvent(this.stagingSnapshot(plugin), this.stagingSnapshot(rejected), initiatedAt),
    );
    this.logger.log(`Plugin '${plugin.slug}' pending update ${plugin.pendingVersion} rejected and cleared`);

    return rejected;
  }

  /**
   * The shared approve/describe prologue: load by slug with the
   * not-found / tombstoned / no-pending distinctions, re-validate both
   * stored manifests, and recompute the escalation comparison against
   * TODAY's decisions — never replayed from staging, because decisions can
   * change between stage and now. One implementation on purpose: the
   * pending read exists so the screen and the approval cannot disagree,
   * and that guarantee is only as strong as both paths running literally
   * the same pipeline.
   *
   * `bgeCompat` is ENFORCED on the stored pending manifest (not just at
   * staging): BGE itself may have moved since, and describing or approving
   * a version that can no longer load would trade a typed refusal here for
   * a quarantine at the next boot.
   */
  private async resolvePendingUpdate(slug: string): Promise<{
    readonly plugin: Plugin;
    readonly active: PluginManifestValidationResult;
    readonly next: PluginManifestValidationResult;
    readonly corePermissions: ReadonlyMap<string, Permission>;
    readonly comparison: UpdateEscalationComparison;
  }> {
    const plugin = await this.loadUpdatablePlugin(slug);

    if (plugin.pendingVersion === null || plugin.pendingManifestJson === null) {
      throw new PluginUpdateNoPendingError(plugin.slug);
    }

    const next = this.validateStoredManifest(plugin, plugin.pendingManifestJson, plugin.pendingVersion, {
      enforceBgeCompat: true,
      label: 'pending',
    });
    const active = this.validateActiveManifest(plugin);
    const corePermissions = await this.loadCorePermissions(next);
    const comparison = await this.compare(plugin, active, next, corePermissions);

    return { plugin, active, next, corePermissions, comparison };
  }

  /** A tombstoned row is not an update target, and the distinction deserves its own error (#59). */
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
        'new',
        `manifest.json could not be read or parsed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const next = this.validate(raw, directory.slug, { enforceBgeCompat: true, label: 'new' });

    if (next.manifest.slug !== plugin.slug) {
      throw new PluginUpdateManifestError(
        directory.slug,
        'new',
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
        context.label,
        `stored ${context.label} manifest identifies '${validated.manifest.slug}'@${validated.manifest.version} but the row ` +
          `says '${plugin.slug}'@${expectedVersion} — drifted state makes the escalation comparison meaningless`,
      );
    }

    return validated;
  }

  private validate(
    raw: unknown,
    slug: string,
    context: { readonly enforceBgeCompat: boolean; readonly label: PluginUpdateManifestSource },
  ): PluginManifestValidationResult {
    try {
      return validatePluginManifest(raw, {
        bgeVersion: this.options.bgeVersion,
        defaultLocale: this.options.defaultLocale,
        enforceBgeCompat: context.enforceBgeCompat,
      });
    } catch (err) {
      if (err instanceof PluginManifestValidationError) {
        throw new PluginUpdateManifestError(
          slug,
          context.label,
          `${context.label} manifest failed validation`,
          err.issues,
        );
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

    const [violation] = [
      ...collectWildcardSubjectViolations(next, bySlug),
      ...collectUnboundedUnitConsentViolations(next, bySlug),
    ];

    if (violation !== undefined) {
      throw new PluginUpdateForbiddenPermissionError(next.manifest.slug, violation.permissionSlug, violation.detail);
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
   * to an explicit Low and can never risk-escalate; core risk is the
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
   * The activation entry point: one bounded retry around the transaction,
   * for the one race the transaction's own reads cannot close.
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
    reentry?: {
      readonly confirmCriticalSlugs: readonly string[];
      readonly riskEscalatedChecks: readonly NormalizedPermissionRequest[];
    },
  ): Promise<ActivationOutcome> {
    // Compiled here rather than inside the transaction: the retained-config
    // validation below (D-CN) runs holding the claimed row, and ajv's codegen
    // has no business inside that window (mirrors `install()`'s own warm
    // call, and `reconcileHouseholdDormancy`'s for the household axis).
    this.configSchema.warm({
      slug: next.manifest.slug,
      version: next.manifest.version,
      schema: next.manifest.config.schema,
    });

    const attempt = (): Promise<ActivationOutcome> =>
      this.activateInTransaction(
        plugin,
        active,
        next,
        provenance,
        comparison,
        checksToSeed,
        corePermissions,
        actorId,
        initiatedAt,
        reentry,
      );

    try {
      return await attempt();
    } catch (error) {
      // A deadlock joins the collision on this path (#398, D-398-2). It is not
      // this transaction being wrong about anything — Postgres chose a victim
      // of a cycle — but the recovery is identical: the abort took the whole
      // transaction with it, so the honest answer is to run it again. Sharing
      // the ONE retry rather than nesting a second is deliberate: two bounded
      // retries compose into four attempts, and the bound is the point.
      if (!isGrantDecisionCollision(error) && !isDeadlockError(error)) {
        throw error;
      }

      // The transaction's decision read is a snapshot, not a lock on keys
      // that do not exist yet: a decision committing between that read and
      // the seeding write still collides on the grant unique. Nothing is
      // half-done when it does — the violation aborts the transaction
      // whole, every accumulator lives inside it, and the events emit only
      // after it commits — so the honest answer is to run the whole thing
      // again against a snapshot that can SEE the decision. The second
      // attempt then reaches the verdict on its own terms: a durable denial
      // refuses, a decided check drops out of the seed set, and a shrunken
      // authority re-challenges the second factor.
      //
      // Once, not until-success. A second collision means a decider is
      // committing faster than an approval can, and answering that with an
      // unbounded loop would hold the claim open against it; the violation
      // propagates instead, exactly as it does today.
      return await attempt();
    }
  }

  /**
   * The activation transaction, shared by the immediate path and
   * `approve()`: promote the pending state, apply the `declares[]`
   * catalog diff (insert added rows, revoke and delete grants on removed
   * declares with `'permission-removed'` provenance, delete the rows),
   * seed the approval's server grants, suspend household AND user units
   * lacking consent on their scope's re-consent escalations (#225),
   * and set `restartRequired`. Events are collected inside and
   * emitted by the caller AFTER commit.
   */
  private async activateInTransaction(
    plugin: Plugin,
    active: PluginManifestValidationResult,
    next: PluginManifestValidationResult,
    provenance: PluginUpdateProvenance,
    comparison: UpdateEscalationComparison,
    checksToSeed: readonly NormalizedPermissionRequest[],
    corePermissions: ReadonlyMap<string, Permission>,
    actorId: string,
    initiatedAt: Date,
    /**
     * `approve()`'s second-factor inputs, re-verified inside the
     * transaction against the tx-local seed set. Absent on the immediate
     * `stage()` path, which never seeds through an approval — nothing
     * escalated to confirm.
     */
    reentry?: {
      readonly confirmCriticalSlugs: readonly string[];
      readonly riskEscalatedChecks: readonly NormalizedPermissionRequest[];
    },
  ): Promise<ActivationOutcome> {
    return this.db.$transaction(async (tx) => {
      // Row-LOCKED, not a plain read (D-CN). `PluginLifecycleService.updateConfig`
      // is a plain UPDATE with no version precondition ("last-writer-wins by
      // decision") targeting the same living-row state (`uninstalledAt: null`)
      // the claim below does. An unlocked read here could snapshot `config`
      // right before that PATCH commits, and the write below would then
      // silently overwrite the admin's fresh document with the stale one —
      // worse than ordinary last-writer-wins, since the write that "wins"
      // was never the actual last writer's intent. `FOR UPDATE` makes the two
      // mutually exclusive, same reasoning as the grant lock below: the
      // PATCH's UPDATE either commits before this SELECT (and is read here)
      // or blocks until this transaction commits (and lands after
      // activation). Raw SQL because Prisma's query API cannot express FOR
      // UPDATE; unqualified table name so the search_path (per-worker test
      // schemas) resolves it. Placed first in the transaction, ahead of the
      // grant lock below, matching the plugin row → grant row → advisory →
      // unit row total order `household-dormancy.ts` and `unit-scope-lock.ts`
      // already document.
      const [current] = await tx.$queryRaw<{ config: Prisma.JsonValue }[]>`
        SELECT config FROM plugins WHERE id = ${plugin.id} FOR UPDATE`;

      if (current === undefined) {
        throw new Error(`Plugin '${plugin.slug}' row vanished mid-activation`);
      }

      const retainedConfig = retainedServerConfig(this.configSchema, next.manifest, current.config);

      // The claim runs FIRST, guarded on the tombstone AND on the exact
      // pending state this activation was computed from. The tombstone half
      // is #320's guard: an uninstall committing between the caller's load
      // and here would strand the writes below on a tombstoned plugin,
      // where the reinstall's fresh seed collides on the grant unique index
      // and the plugin can never be installed again. The pending half
      // closes the concurrent-resolution race the endpoints opened (#321):
      // two approves both loading the same staged row would both reach
      // here, and the loser — its update already consumed — would either
      // die on that same unique index (an untyped 500) or silently
      // re-activate; on the immediate stage() path (pending columns null)
      // the same predicate keeps a concurrently staged update from being
      // clobbered by this write's cleared columns. pendingSince rides the
      // predicate as the staging IDENTITY: a rejected version can be
      // re-staged under the same number with different content, so the
      // version alone would let this claim promote a payload the approver
      // never reviewed — the staging timestamp is fresh per staging write
      // and cannot be re-entered. Claiming before any other write means
      // the loser exits with a typed refusal while the transaction has
      // touched nothing.
      const claimed = await tx.plugin.updateMany({
        where: {
          id: plugin.id,
          uninstalledAt: null,
          pendingVersion: plugin.pendingVersion,
          pendingSince: plugin.pendingSince,
        },
        data: {
          version: next.manifest.version,
          // Row identity columns follow the manifest they mirror — a version
          // may legitimately re-categorize or re-scope. `executionMode` is
          // deliberately NOT refreshed: the manifest value is an install-time
          // hint and the column is admin-owned after that (#197).
          category: MANIFEST_CATEGORY_TO_PRISMA[next.manifest.category],
          scope: MANIFEST_SCOPE_TO_PRISMA[next.manifest.scope],
          manifestJson: next.manifest as Prisma.InputJsonValue,
          // D-CN: rides the same reset-on-mismatch rule reinstall applies,
          // so activation is not the one manifest-replacing path that leaves
          // a stale server config in force.
          config: retainedConfig.config as Prisma.InputJsonValue,
          ...(provenance.bundled ? {} : { installedSha256: provenance.pendingSha256 }),
          ...CLEARED_STAGED_UPDATE,
          // The running instance is still the prior code; the loader
          // clears this on the boot that actually loads the new version.
          restartRequired: true,
        },
      });

      if (claimed.count !== 1) {
        const current = await tx.plugin.findUnique({
          where: { id: plugin.id },
          select: { uninstalledAt: true, pendingVersion: true },
        });

        if (current?.uninstalledAt != null) {
          throw new PluginUpdateTombstonedError(plugin.slug, current.uninstalledAt);
        }

        // The pending state moved. Which refusal is right depends on which
        // caller this is: an approval's staged update was consumed or
        // replaced (nothing left for THIS approval to resolve), while the
        // immediate stage() path lost the empty slot to a concurrent stage
        // — the same refuse-don't-supersede answer the staging write gives.
        if (plugin.pendingVersion !== null) {
          throw new PluginUpdateNoPendingError(plugin.slug);
        }

        throw new PluginUpdatePendingConflictError(
          plugin.slug,
          current?.pendingVersion ?? 'unknown',
          next.manifest.version,
        );
      }

      // The server-scope decisions re-read under the SAME transaction as
      // the claim, and everything downstream of them re-derived. The gates
      // in approve() ran before this transaction opened, and a decision —
      // #322's decide() seam — can land in between: a fresh durable denial
      // on a required check must refuse HERE, where the throw takes the
      // claim back with it, and a check decided since the caller computed
      // its seed set must drop out of the seeding rather than collide on
      // the grant unique index as an untyped 500.
      //
      // LOCKED, not just re-read (#356). `decide()` UPDATEs an existing row
      // from its own transaction, and an update raises no unique violation,
      // so the bounded retry below never sees a Granted → Denied flip
      // landing after a plain snapshot — activation would commit a manifest
      // the required-denial rule (D-AV) should have refused. `FOR UPDATE`
      // takes a row lock on every server grant, and Postgres row locks are
      // mutual: `decide()`'s upsert blocks until this transaction resolves,
      // so the flip either commits before this read (and refuses below) or
      // serializes after activation — where `decide()`'s own in-transaction
      // re-check (`assertDenialStillLegal`) re-reads the then-ACTIVE
      // manifest and refuses the flip itself. Raw SQL because Prisma's query API
      // cannot express FOR UPDATE; unqualified table name so the search_path
      // (per-worker test schemas) resolves it. The lock covers EXISTING rows
      // only — a row that does not exist cannot be locked — so the
      // insert-half race stays with the unique index and the retry.
      const lockedGrantRows = await tx.$queryRaw<{ permission_slug: string; status: PluginGrantStatus }[]>`
        SELECT permission_slug, status
        FROM plugin_grants
        WHERE plugin_id = ${plugin.id} AND scope_type = 'Server'
        FOR UPDATE`;
      const serverGrants = lockedGrantRows.map((row) => ({
        permissionSlug: row.permission_slug,
        status: row.status,
      }));
      const deniedServerSlugs = new Set(
        serverGrants.filter((grant) => grant.status === PluginGrantStatus.Denied).map((grant) => grant.permissionSlug),
      );
      // Same rule the comparator applies: a Server-scope denial blocks only
      // a check the NEXT manifest requires at server consent.
      const blockedByDenial = next.permissionChecks
        .filter(
          (check) => check.consentScope === 'server' && check.required && deniedServerSlugs.has(check.canonicalSlug),
        )
        .map((check) => check.canonicalSlug);

      if (blockedByDenial.length > 0) {
        throw new PluginUpdateBlockedByDenialError(plugin.slug, blockedByDenial);
      }

      const decidedServerSlugs = new Set(serverGrants.map((grant) => grant.permissionSlug));
      const seededChecks = checksToSeed.filter((check) => !decidedServerSlugs.has(check.canonicalSlug));

      // The second factor, re-verified against what this transaction will
      // actually GRANT: a concurrent decision that shrank the seed set
      // shrank the authority this approval confers, and a confirmation for
      // the old, larger set no longer matches — re-challenging with the
      // current expectation is the same exact-re-entry answer approve()
      // gives before the transaction.
      if (reentry !== undefined) {
        const expectedCritical = criticalConfirmationExpectation(
          [...seededChecks, ...reentry.riskEscalatedChecks],
          corePermissions,
        );
        const confirmation = compareExactReentry(expectedCritical, reentry.confirmCriticalSlugs);

        if (!confirmation.exact) {
          throw new PluginUpdateCriticalConfirmationError(plugin.slug, confirmation.expected, confirmation.received);
        }
      }

      const { added: addedDeclares, removed: removedDeclares } = declaredSlugDiff(active, next);

      // Grants on removed declares are deleted with
      // 'permission-removed' provenance — collected BEFORE deletion because
      // the revocation events are the only durable record of what lapsed.
      let revokedGrants: PluginGrant[] = [];

      if (removedDeclares.length > 0) {
        // Copied because Prisma's `in` takes a mutable array and the diff is
        // shared with the read that renders it, which must not hand out one.
        const removed = [...removedDeclares];

        revokedGrants = await tx.pluginGrant.findMany({
          where: { pluginId: plugin.id, permissionSlug: { in: removed } },
        });
        await tx.pluginGrant.deleteMany({ where: { pluginId: plugin.id, permissionSlug: { in: removed } } });
        await tx.pluginPermission.deleteMany({ where: { pluginId: plugin.id, slug: { in: removed } } });
      }

      for (const slug of addedDeclares) {
        await tx.pluginPermission.create({
          // Explicit Low, never the manifest and never a schema default (#59).
          data: { pluginId: plugin.id, slug, riskLevel: RiskLevel.Low },
        });
      }

      // Re-stamp: approval is the consent act for a server-scope risk
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

      for (const check of seededChecks) {
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

      const updated = await tx.plugin.findUniqueOrThrow({ where: { id: plugin.id } });

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
            // decidedRiskLevel is load-bearing, not decoration: for a risk
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

      // Runs AFTER the suspension passes so a row this activation both
      // suspends and makes dormant carries both, and the dormancy snapshots
      // describe the row as it finally stands.
      const dormancyTransitions = await reconcileHouseholdDormancy({
        tx,
        pluginId: plugin.id,
        manifest: next.manifest,
        configSchema: this.configSchema,
        initiatedAt,
      });

      return {
        plugin: updated,
        seededChecks,
        seededGrants,
        revokedGrants,
        scopeMovedGrants,
        reStampedGrants,
        suspendedHouseholdUnits,
        suspendedUserUnits,
        dormancyTransitions,
        retainedConfigReset: retainedConfig.reset,
      };
    });
  }

  /** Post-commit emissions, matching the commit-then-emit discipline everywhere else. */
  private emitActivation(
    before: Plugin,
    outcome: ActivationOutcome,
    next: PluginManifestValidationResult,
    initiatedAt: Date,
  ): void {
    // The tx-local seeded set: a concurrent decision may have shrunk the
    // caller's, and the event must describe what was actually granted.
    const grantedPermissions: GrantedPermissionRecord[] = outcome.seededChecks.map((check) => ({
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
        outcome.retainedConfigReset,
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

    emitHouseholdDormancy(this.emitter, outcome.dormancyTransitions, next.manifest.version, initiatedAt);
  }

  /**
   * Which units of one scope owe a fresh decision under this activation —
   * the pure half of the suspension pass, shared by the household and user
   * blocks in `activate()` so the covering predicate cannot drift between
   * scopes. A slug is outstanding unless the unit has a Granted row AND the
   * risk it consented under still covers today's classification (#59).
   */
  private suspensionCandidates<TUnit>(args: {
    readonly units: readonly TUnit[];
    readonly scopeIdOf: (unit: TUnit) => string;
    /** Constructed, not read back — the write sets exactly the suspension fields; `enabled` intent is untouched. */
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
