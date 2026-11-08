import {
  constraintIdentity,
  DatabaseService,
  identifiesConstraint,
  isDeadlockError,
  PluginGrantScope,
  PluginGrantStatus,
  Prisma,
  RiskLevel,
  SERVER_SCOPE_SENTINEL,
  type HouseholdPlugin,
  type Permission,
  type Plugin,
  type PluginGrant,
  type UserPlugin,
} from '@bge/database';
import {
  parsePluginArtifactSha256,
  type PluginArtifactDirectory,
  type PluginArtifactSha256,
} from '@boardgamesempire/plugin-contract';
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
import { createId } from '@paralleldrive/cuid2';
import { readFile } from 'node:fs/promises';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import { retainedServerConfig } from '../config/retained-server-config';
import {
  consentCatalogFlags,
  decideConsentCheck,
  type ConsentCheckDecisionInput,
} from '../consent/plugin-consent-check-classifier.service';
import {
  HouseholdPluginReconsentRequestedEvent,
  PluginGrantRevokedEvent,
  PluginUpdateApprovedEvent,
  PluginUpdatePendingEvent,
  PluginUpdateRejectedEvent,
  UserPluginReconsentRequestedEvent,
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
import { PluginDirectoryLayoutError } from '../loader/loader.errors';
import { PluginDirectoryResolverService } from '../loader/plugin-directory-resolver.service';
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
  PluginUpdateStagingReplacedError,
  PluginUpdateStaticAnalysisError,
  PluginUpdateTombstonedError,
  PluginUpdateUnknownCorePermissionError,
  PluginUpdateVersionConflictError,
} from './update.errors';

/**
 * `PluginGrant`'s decision unique, in every spelling `constraintIdentity` can
 * report it: the index name the driver adapter reports since
 * `@prisma/adapter-pg@7.10` (the shape that ships), the raw columns it reported
 * before, and Prisma field names in case a release restores `meta.target`.
 *
 * The index name is Prisma's default for the `@@unique`, as created in
 * `20260722232927_plugins`; naming it in the schema with `map:` would change it.
 */
const GRANT_DECISION_UNIQUE_INDEX = 'plugin_grants_plugin_id_scope_type_scope_id_permission_slug_key';
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
  return identifiesConstraint(
    constraintIdentity(error),
    [GRANT_DECISION_UNIQUE_INDEX],
    GRANT_DECISION_UNIQUE_COLUMNS,
    GRANT_DECISION_UNIQUE_FIELDS,
  );
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
 * The requested permissions the next manifest stops requesting at any
 * consent scope (#577). A permission still requested at another scope is a
 * scope move, which the comparison owns. One whose declaration the update
 * also drops is left to the declares diff, so its decisions revoke once,
 * as `'permission-removed'`. The approval screen and activation both use it,
 * so the screen cannot show less than approving deletes.
 */
function requestedSlugsDropped(
  active: PluginManifestValidationResult,
  next: PluginManifestValidationResult,
  removedDeclares: readonly string[],
): string[] {
  const stillRequested = new Set(next.permissionChecks.map((check) => check.canonicalSlug));
  const removed = new Set(removedDeclares);

  return [
    ...new Set(
      active.permissionChecks
        .map((check) => check.canonicalSlug)
        .filter((slug) => !stillRequested.has(slug) && !removed.has(slug)),
    ),
  ];
}

/** A staged update resolved and compared, as the approval and the staged-update read both see it. */
interface ResolvedPendingUpdate {
  readonly plugin: Plugin;
  readonly active: PluginManifestValidationResult;
  readonly next: PluginManifestValidationResult;
  readonly corePermissions: ReadonlyMap<string, Permission>;
  readonly comparison: UpdateEscalationComparison;
}

/** What an approval brings to the resolution: the staging it answers (#357). */
interface PendingUpdateApproval {
  readonly stagingId: string;
}

interface ResolvedPendingApproval extends ResolvedPendingUpdate {
  /** The staged plugin artifact's checksum, which activation records as `installedSha256`. */
  readonly pendingSha256: PluginArtifactSha256;
}

export interface PluginUpdateStageInput {
  /**
   * The NEW version's plugin artifact directory, which update staging is to
   * place (planned, #1096). Its checksum is the one the staging records as
   * `pendingSha256` (#224); the link and
   * registry columns keep describing the INSTALL. This service never opens
   * the plugin artifact itself (#59).
   */
  readonly directory: PluginArtifactDirectory;
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
  /**
   * The staging this approval answers, as the staged-update read reported it
   * (#357). Any other current staging refuses with
   * `PluginUpdateStagingReplacedError`, so an approval never activates a
   * staging its approver didn't review.
   */
  readonly stagingId: string;
  /** Exact re-entry of every Critical permission slug this approval will GRANT — the same second factor install demands (#59). */
  readonly confirmCriticalSlugs?: readonly string[];
}

/** One household unit an approval told it owes re-consent, with the slugs it has not yet granted (#321, #1149). */
export interface PluginUpdateReconsentHouseholdUnit {
  readonly householdId: string;
  readonly outstanding: readonly string[];
}

/** One user unit an approval told it owes re-consent — the household shape's user-axis mirror (#225). */
export interface PluginUpdateReconsentUserUnit {
  readonly userId: string;
  readonly outstanding: readonly string[];
}

export interface PluginUpdateApproveResult {
  readonly plugin: Plugin;
  readonly comparison: UpdateEscalationComparison;
  /** Server-scope grants seeded by this approval — the new server-consentable checks. */
  readonly seededGrants: readonly PluginGrant[];
  /**
   * Enabled units that do not cover every re-consent slug of their scope
   * under the new manifest, per axis (#321, #1149). Nothing was written to
   * them: each keeps running on exactly the grants it gave, the ability
   * denies what it has not granted, and its consent standing reports review
   * pending until it answers. The server admin who approved needs this
   * synchronously; the re-consent events name the same units and slugs, but
   * an event stream is not a response body.
   */
  readonly reconsentHouseholdUnits: readonly PluginUpdateReconsentHouseholdUnit[];
  readonly reconsentUserUnits: readonly PluginUpdateReconsentUserUnit[];
}

export interface PluginUpdateRejectInput {
  readonly slug: string;
  readonly rejectorId: string;
  /** The staging this rejection answers, as the staged-update read reported it (#357). */
  readonly stagingId: string;
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
  /**
   * The requested permissions the update stops requesting (#577), from the
   * function activation applies. Approving deletes every decision on them,
   * granted and denied, at every scope, so this is destructive too. A
   * permission whose declaration the update removes is in `declares.removed`
   * instead.
   */
  readonly noLongerRequested: readonly string[];
}

/** One enabled unit that owes re-consent under the activated manifest, with the slugs it has not yet granted. */
/** Covering inputs for a slug the catalog has no row for: nothing confers. */
const NO_CATALOG_ROW: Omit<ConsentCheckDecisionInput, 'grant'> = {
  currentRiskLevel: null,
  wildcardSubject: false,
  unboundedUnitScope: false,
};

interface ReconsentCandidate<TUnit> {
  readonly unit: TUnit;
  readonly outstanding: readonly string[];
}

interface ActivationOutcome {
  readonly plugin: Plugin;
  /** The checks actually seeded — the caller's set re-filtered against the tx-local decisions (see `activate()`). */
  readonly seededChecks: readonly NormalizedPermissionRequest[];
  readonly seededGrants: readonly PluginGrant[];
  readonly revokedGrants: readonly PluginGrant[];
  /** Decisions deleted because the next manifest stopped requesting their permission (#577). */
  readonly unrequestedGrants: readonly PluginGrant[];
  /** Grants deleted because their permission moved consent scope. */
  readonly scopeMovedGrants: readonly PluginGrant[];
  /** Server-scope grants whose `decidedRiskLevel` this approval refreshed (#59). */
  readonly reStampedGrants: readonly PluginGrant[];
  /** Enabled household units that owe re-consent — announced after commit, never written (#1149). */
  readonly reconsentHouseholdUnits: readonly ReconsentCandidate<HouseholdPlugin>[];
  /** The user-scope mirror (#225). */
  readonly reconsentUserUnits: readonly ReconsentCandidate<UserPlugin>[];
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
 * `'permission-removed'` grant revocation, `'permission-no-longer-requested'`
 * revocation of decisions on permissions the new manifest stops requesting
 * (#577) — and sets
 * `restartRequired`; the running instance continues on the prior code until
 * the next boot, where the loader clears the flag. No forced restart:
 * updating several plugins in one sitting must not bounce the server N
 * times. A real teardown path arrives with #197's worker mode.
 *
 * Activation never stops a household's or user's plugin over consent
 * (#1149). An enabled unit that does not cover its scope's re-consent slugs
 * is told it owes re-consent and keeps running on its existing grants: the
 * ability denies what it has not granted, and its consent standing reports
 * review pending until it answers. Household and user units are judged
 * alike (#225). Users with no unit enablement are untouched: no row means
 * not enabled, so there is nobody to tell.
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
    private readonly directories: PluginDirectoryResolverService,
  ) {}

  async stage(input: PluginUpdateStageInput): Promise<PluginUpdateStageResult> {
    const initiatedAt = new Date();

    if (!(await this.authority.isServerAdmin(input.initiatorId))) {
      throw new PluginUpdateAuthorityError(input.initiatorId);
    }

    // Before anything is read from it or recorded: approval is to make this
    // checksum the one the loader resolves, so a directory the resolver would
    // refuse at that boot is refused now, with the same error (#224).
    const directory = await this.directories.confirm(input.directory);

    const plugin = await this.loadUpdatablePlugin(directory.slug);

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
    // their consent is the units', and activation announces the re-consent
    // they owe (#1149).
    if (!comparison.serverGating && comparison.blockedByDenial.length === 0) {
      const outcome = await this.activate(
        plugin,
        active,
        next,
        directory.sha256,
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
          pendingSha256: directory.sha256,
          pendingSince: initiatedAt,
          // The staging's identity (#357): fresh for every staging, even one
          // of the same version from the same artifact, so a rejection or an
          // approval aimed at an earlier staging can never match this one.
          pendingStagingId: createId(),
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
        directory.sha256,
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

    const { plugin, active, next, corePermissions, comparison, pendingSha256 } = await this.resolvePendingUpdate(
      input.slug,
      { stagingId: input.stagingId },
    );

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
      pendingSha256,
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
        `${outcome.revokedGrants.length + outcome.unrequestedGrants.length + outcome.scopeMovedGrants.length} revoked, ` +
        `${outcome.reconsentHouseholdUnits.length} household and ${outcome.reconsentUserUnits.length} user ` +
        `unit(s) owe re-consent; restart required`,
    );

    return {
      plugin: outcome.plugin,
      comparison,
      seededGrants: outcome.seededGrants,
      // The same candidate lists emitActivation announces, so the result and
      // the events cannot name different units or slugs (#1149).
      reconsentHouseholdUnits: outcome.reconsentHouseholdUnits.map((candidate) => ({
        householdId: candidate.unit.householdId,
        outstanding: candidate.outstanding,
      })),
      reconsentUserUnits: outcome.reconsentUserUnits.map((candidate) => ({
        userId: candidate.unit.userId,
        outstanding: candidate.outstanding,
      })),
    };
  }

  /**
   * The approval screen's data source (#321): the pending update resolved
   * and compared exactly as `approve()` resolves it — literally the same
   * pipeline, via {@link resolvePendingUpdate} — so the screen and the
   * approval cannot disagree about what the update escalates.
   *
   * A pure read with three deliberate asymmetries from `approve()`: no
   * server-admin re-verification (reading is not a consent act — the edge
   * guards it with `read:plugin`); a durable denial is RENDERED as
   * `comparison.blockedByDenial` rather than thrown — the screen's job is
   * to show the block, the approval's job is to refuse over it; and the
   * staged checksum is not checked, because only activation uses it, and
   * refusing a corrupt one here would hide a staging the server admin may
   * want to reject (#1117).
   */
  async describePending(slug: string): Promise<PluginUpdatePendingDescription> {
    const { plugin, active, next, comparison } = await this.resolvePendingUpdate(slug);
    const declares = declaredSlugDiff(active, next);

    return {
      plugin,
      comparison,
      pendingSince: plugin.pendingSince,
      declares,
      noLongerRequested: requestedSlugsDropped(active, next, declares.removed),
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

    if (plugin.pendingStagingId !== input.stagingId) {
      throw new PluginUpdateStagingReplacedError(plugin.slug, input.stagingId);
    }

    // Conditional on the EXACT staging the rejector saw, like every other
    // staged-update writer: an unconditional clear racing an approve would
    // report "rejected" for an update that in fact activated, and emit
    // update_rejected for code that had just become the active version's.
    // Racing a replacement stage, it would wipe a staged version nobody
    // decided on — and because a rejected version can be re-staged under the
    // SAME number (only the ACTIVE version is refused), the version is not
    // identity enough, and neither is the checksum, since staging the same
    // artifact again gives the same one. pendingStagingId, written fresh by
    // every staging, is what pins the staging this rejection targets (#357);
    // pendingSince is for display, and two stagings can share its millisecond.
    const rejected = await this.db.$transaction(async (tx) => {
      const cleared = await tx.plugin.updateMany({
        where: {
          id: plugin.id,
          pendingVersion: plugin.pendingVersion,
          pendingStagingId: plugin.pendingStagingId,
          uninstalledAt: null,
        },
        data: CLEARED_STAGED_UPDATE,
      });

      if (cleared.count !== 1) {
        const current = await tx.plugin.findUnique({
          where: { id: plugin.id },
          select: { uninstalledAt: true, pendingStagingId: true },
        });

        if (current?.uninstalledAt != null) {
          throw new PluginUpdateTombstonedError(plugin.slug, current.uninstalledAt);
        }

        // Another staging took the slot after the check above: the rejector
        // answered one that is gone, the same answer as if it had already
        // been gone when the request arrived (#357).
        if (current?.pendingStagingId != null && current.pendingStagingId !== input.stagingId) {
          throw new PluginUpdateStagingReplacedError(plugin.slug, input.stagingId);
        }

        throw new PluginUpdateNoPendingError(plugin.slug);
      }

      // Read back INSIDE the claim, like the staging and activation writes.
      // The clear leaves `pendingVersion` null, which is exactly the slot
      // stage() claims on, so an outside read-back can observe a NEWLY
      // staged version — handing this response, and the rejected event's
      // `after` snapshot, a staged update nobody rejected. The atomic
      // single-statement update this replaced could not express that state;
      // the guarded updateMany can.
      return tx.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
    });

    // Removing the staged artifact's directory, once no living row names it,
    // is the planned artifact sweep's job (#1094, #224); this service never
    // touches the filesystem beyond reading manifests (#59).
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
   *
   * An approval passes the staging it answers, and gets the staged checksum
   * back as well, checked (#357, #1117). The staged-update read passes
   * neither.
   */
  private resolvePendingUpdate(slug: string): Promise<ResolvedPendingUpdate>;
  private resolvePendingUpdate(slug: string, approval: PendingUpdateApproval): Promise<ResolvedPendingApproval>;
  private async resolvePendingUpdate(
    slug: string,
    approval?: PendingUpdateApproval,
  ): Promise<ResolvedPendingUpdate & { readonly pendingSha256?: PluginArtifactSha256 }> {
    const plugin = await this.loadUpdatablePlugin(slug);

    // A staged row without its checksum names no plugin artifact, so there
    // is nothing approval could activate (#696): it is not a staged update.
    if (plugin.pendingVersion === null || plugin.pendingManifestJson === null || plugin.pendingSha256 === null) {
      throw new PluginUpdateNoPendingError(plugin.slug);
    }

    // Before the staged manifest is validated or compared: a staging the
    // approver never saw is refused for that, whatever else is wrong with it.
    if (approval !== undefined && plugin.pendingStagingId !== approval.stagingId) {
      throw new PluginUpdateStagingReplacedError(plugin.slug, approval.stagingId);
    }

    // Activation makes the staged checksum a path segment and
    // `installedSha256`. The database refuses any other form
    // (plugins_pending_sha256_format, #1117), so this is the backstop the
    // brand needs: an approval refuses a corrupt value as the resolver refuses
    // it at the next boot, before any manifest or escalation work. The read
    // never uses it, so it never refuses it.
    const pendingSha256 = approval === undefined ? undefined : parsePluginArtifactSha256(plugin.pendingSha256);

    if (pendingSha256 === null) {
      throw new PluginDirectoryLayoutError(plugin.slug, 'the staged checksum is not 64 lowercase hex characters');
    }

    const next = this.validateStoredManifest(plugin, plugin.pendingManifestJson, plugin.pendingVersion, {
      enforceBgeCompat: true,
      label: 'pending',
    });
    const active = this.validateActiveManifest(plugin);
    const corePermissions = await this.loadCorePermissions(next);
    const comparison = await this.compare(plugin, active, next, corePermissions);

    return { plugin, active, next, corePermissions, comparison, pendingSha256 };
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
    directory: PluginArtifactDirectory,
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
    // A retired slug (#235) reads as unknown: the new manifest cannot bind to it.
    const rows =
      slugs.length === 0
        ? []
        : await this.db.permission.findMany({ where: { slug: { in: [...slugs] }, retiredAt: null } });
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
    /** The checksum of the plugin artifact being activated, which becomes `installedSha256` (#224). */
    artifactSha256: PluginArtifactSha256,
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
        artifactSha256,
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
   * revoke and delete decisions on permissions the next manifest stops
   * requesting with `'permission-no-longer-requested'` provenance (#577),
   * seed the approval's server grants, work out which enabled household AND
   * user units do not cover their scope's re-consent slugs (#225) — a read,
   * never a write to their rows (#1149) — and set `restartRequired`. Events,
   * the re-consent announcements among them, are collected inside and
   * emitted by the caller AFTER commit.
   */
  private async activateInTransaction(
    plugin: Plugin,
    active: PluginManifestValidationResult,
    next: PluginManifestValidationResult,
    artifactSha256: PluginArtifactSha256,
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
      // clobbered by this write's cleared columns. pendingStagingId rides
      // the predicate as the staging IDENTITY (#357): a rejected version can
      // be re-staged under the same number, with different content or from
      // the same artifact, so neither the version nor the checksum would
      // stop this claim promoting a payload the approver never reviewed, and
      // a timestamp can repeat. The staging id is fresh per staging write
      // and never reused. Claiming before any other write means the loser
      // exits with a typed refusal while the transaction has touched nothing.
      const claimed = await tx.plugin.updateMany({
        where: {
          id: plugin.id,
          uninstalledAt: null,
          pendingVersion: plugin.pendingVersion,
          pendingStagingId: plugin.pendingStagingId,
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
          // Activation switches which artifact directory the row names, and
          // nothing on disk moves: the loader finds the new code by this
          // checksum on the next boot (#224).
          installedSha256: artifactSha256,
          ...CLEARED_STAGED_UPDATE,
          // The running instance is still the prior code; the loader
          // clears this on the boot that actually loads the new version.
          restartRequired: true,
        },
      });

      if (claimed.count !== 1) {
        const current = await tx.plugin.findUnique({
          where: { id: plugin.id },
          select: { uninstalledAt: true, pendingVersion: true, pendingStagingId: true },
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
          // Another staging took the slot after approve() checked it: the
          // approver reviewed one that is gone (#357).
          if (
            plugin.pendingStagingId !== null &&
            current?.pendingStagingId != null &&
            current.pendingStagingId !== plugin.pendingStagingId
          ) {
            throw new PluginUpdateStagingReplacedError(plugin.slug, plugin.pendingStagingId);
          }

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
      // mutual. `decide()` waits earlier than its upsert, though: it claims
      // the plugin row `FOR SHARE` before writing anything (#398), and that
      // claim waits on this transaction's `FOR UPDATE` of the same row. So the
      // flip either committed before this transaction's claim (and this read
      // refuses below) or serializes after activation, where that claim
      // compares the plugin manifest `decide()` judged against with the
      // then-active one and refuses the flip itself (#361). Raw SQL because
      // Prisma's query API cannot express FOR UPDATE; unqualified table name
      // so the search_path (per-worker test schemas) resolves it. The lock covers EXISTING rows
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

      // Decisions on a permission the next manifest stops requesting are
      // deleted, granted and denied alike, with 'permission-no-longer-requested'
      // provenance (#577). Left in place, a later version that requests the
      // permission again would inherit a consent decision nobody made for
      // it. Read before the delete, for the same reason as the declares diff.
      // A decide() that judged against the outgoing plugin manifest cannot
      // write one back afterwards: its claim waits for this transaction and
      // then refuses the moved plugin manifest (#361).
      const droppedRequests = requestedSlugsDropped(active, next, removedDeclares);
      let unrequestedGrants: PluginGrant[] = [];

      if (droppedRequests.length > 0) {
        unrequestedGrants = await tx.pluginGrant.findMany({
          where: { pluginId: plugin.id, permissionSlug: { in: droppedRequests } },
        });
        await tx.pluginGrant.deleteMany({ where: { pluginId: plugin.id, permissionSlug: { in: droppedRequests } } });
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

      // Who owes re-consent is worked out here and announced after commit;
      // nothing is written to any unit enablement (#1149). A unit that has
      // not answered keeps running on the grants it gave, and its consent
      // standing is worked out when read, so there is no state here to keep
      // current — and no lock on the enablement to take. Whether a Granted
      // row still covers is `decideConsentCheck`, the rule the standing and
      // the consent surface read, applied to the rows read below, so a unit
      // the standing reads as owing is the unit announced here.
      //
      // Switched-on units only, dormant ones included. A switched-off unit
      // accepts the whole required set afresh when it switches on again, so
      // the announcement would tell it nothing it is not asked then; a dormant
      // unit stays switched on, is asked nothing when its configuration or
      // the plugin's scope is cured, and would otherwise read review_pending
      // without ever having been told. Nothing is judged at switch-on: the
      // standing is read whenever feature state, the inventory or the ability
      // read it, so a unit switched on after activation shows review_pending
      // but is never announced (#1149).
      //
      // Fixed query count regardless of how many units run the plugin: one
      // unit read and one grant read per scope. A per-unit loop put this
      // transaction's duration on the number of installs, and exceeding the
      // interactive-transaction timeout would roll back the whole update —
      // failing an activation because the plugin was POPULAR.
      let reconsentHouseholdUnits: ReconsentCandidate<HouseholdPlugin>[] = [];

      if (comparison.householdReconsentSlugs.length > 0) {
        const units = await tx.householdPlugin.findMany({
          where: { pluginId: plugin.id, enabled: true },
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

          reconsentHouseholdUnits = this.reconsentCandidates({
            units,
            scopeIdOf: (unit) => unit.householdId,
            granted,
            reconsentSlugs: comparison.householdReconsentSlugs,
            coverage: this.coverageInputs(next, corePermissions, PluginGrantScope.Household),
          });
        }
      }

      // The user-scope mirror (#225): identical shape against `UserPlugin`.
      // Users with no unit enablement never appear in the unit read — no row
      // means not enabled, so there is nobody to tell.
      let reconsentUserUnits: ReconsentCandidate<UserPlugin>[] = [];

      if (comparison.userReconsentSlugs.length > 0) {
        const units = await tx.userPlugin.findMany({
          where: { pluginId: plugin.id, enabled: true },
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

          reconsentUserUnits = this.reconsentCandidates({
            units,
            scopeIdOf: (unit) => unit.userId,
            granted,
            reconsentSlugs: comparison.userReconsentSlugs,
            coverage: this.coverageInputs(next, corePermissions, PluginGrantScope.User),
          });
        }
      }

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
        unrequestedGrants,
        scopeMovedGrants,
        reStampedGrants,
        reconsentHouseholdUnits,
        reconsentUserUnits,
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
      ...outcome.unrequestedGrants.map((grant) => ({ grant, reason: 'permission-no-longer-requested' as const })),
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

    // One announcement per unit that owes re-consent (#1149): the durable,
    // notifiable record that a household admin or user has a review pending.
    // The unit enablement did not change, so each event carries one snapshot.
    for (const candidate of outcome.reconsentHouseholdUnits) {
      this.emitter.emit(
        HouseholdPluginReconsentRequestedEvent.eventName,
        new HouseholdPluginReconsentRequestedEvent(
          this.householdUnitSnapshot(candidate.unit),
          candidate.outstanding,
          next.manifest.version,
          initiatedAt,
        ),
      );
    }

    for (const candidate of outcome.reconsentUserUnits) {
      this.emitter.emit(
        UserPluginReconsentRequestedEvent.eventName,
        new UserPluginReconsentRequestedEvent(
          this.userUnitSnapshot(candidate.unit),
          candidate.outstanding,
          next.manifest.version,
          initiatedAt,
        ),
      );
    }

    emitHouseholdDormancy(this.emitter, outcome.dormancyTransitions, next.manifest.version, initiatedAt);
  }

  /**
   * Which units of one scope owe re-consent under this activation — a pure
   * function, shared by the household and user blocks in
   * `activateInTransaction()` so the covering predicate cannot drift between
   * scopes. A slug is outstanding unless the unit's Granted row still
   * confers under `decideConsentCheck`, the same rule the consent standing
   * reads (#1149): a unit that granted a new permission on the staged
   * manifest ahead of time, at a covering risk, owes nothing.
   */
  private reconsentCandidates<TUnit>(args: {
    readonly units: readonly TUnit[];
    readonly scopeIdOf: (unit: TUnit) => string;
    readonly granted: readonly {
      readonly scopeId: string;
      readonly permissionSlug: string;
      readonly decidedRiskLevel: RiskLevel;
    }[];
    readonly reconsentSlugs: readonly string[];
    readonly coverage: ReadonlyMap<string, Omit<ConsentCheckDecisionInput, 'grant'>>;
  }): ReconsentCandidate<TUnit>[] {
    const decidedByUnit = new Map<string, Map<string, RiskLevel>>();

    for (const row of args.granted) {
      const slugs = decidedByUnit.get(row.scopeId) ?? new Map<string, RiskLevel>();
      slugs.set(row.permissionSlug, row.decidedRiskLevel);
      decidedByUnit.set(row.scopeId, slugs);
    }

    const candidates: ReconsentCandidate<TUnit>[] = [];

    for (const unit of args.units) {
      const decided = decidedByUnit.get(args.scopeIdOf(unit)) ?? new Map<string, RiskLevel>();
      const outstanding = args.reconsentSlugs.filter((slug) => {
        const decidedRiskLevel = decided.get(slug);
        // Every re-consent slug is a check of the next manifest, so the
        // inputs exist; a slug without them reads as no catalog row, which
        // confers nothing — the direction that announces rather than omits.
        const inputs = args.coverage.get(slug) ?? NO_CATALOG_ROW;

        return (
          decideConsentCheck({
            grant: decidedRiskLevel === undefined ? undefined : { status: PluginGrantStatus.Granted, decidedRiskLevel },
            ...inputs,
          }).decision !== 'granted'
        );
      });

      if (outstanding.length > 0) {
        candidates.push({ unit, outstanding });
      }
    }

    return candidates;
  }

  /**
   * The catalog side of the covering rule for every check of the next
   * manifest at one deciding scope: today's risk (plugin-declared rows are
   * locked to Low) and the wildcard-subject and unit-binding flags, read the
   * way the classifier reads them. `corePermissions` holds a live row for
   * every core slug the next manifest names, or the update was refused
   * before this point.
   */
  private coverageInputs(
    next: PluginManifestValidationResult,
    corePermissions: ReadonlyMap<string, Permission>,
    decidingScope: PluginGrantScope,
  ): ReadonlyMap<string, Omit<ConsentCheckDecisionInput, 'grant'>> {
    const bySlug = new Map<string, Omit<ConsentCheckDecisionInput, 'grant'>>();

    for (const check of next.permissionChecks) {
      const corePermission = corePermissions.get(check.canonicalSlug);

      bySlug.set(check.canonicalSlug, {
        currentRiskLevel: check.origin === 'plugin' ? RiskLevel.Low : (corePermission?.riskLevel ?? null),
        ...consentCatalogFlags({ origin: check.origin, decidingScope, corePermission }),
      });
    }

    return bySlug;
  }

  private stagingSnapshot(plugin: Plugin) {
    const { id, slug, version, pendingVersion, pendingStagingId } = plugin;

    return { id, slug, version, pendingVersion, pendingStagingId };
  }

  private householdUnitSnapshot(unit: HouseholdPlugin) {
    const { id, householdId, pluginId, enabled } = unit;

    return { id, householdId, pluginId, enabled };
  }

  private userUnitSnapshot(unit: UserPlugin) {
    const { id, userId, pluginId, enabled } = unit;

    return { id, userId, pluginId, enabled };
  }
}
