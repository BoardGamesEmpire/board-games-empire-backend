import { AuditContextService } from '@bge/actor-context';
import {
  DatabaseService,
  PluginCategory,
  PluginConsentActKind,
  PluginGrantScope,
  PluginGrantStatus,
  Prisma,
  RiskLevel,
  SERVER_SCOPE_SENTINEL,
  type HouseholdPlugin,
  type Permission,
  type Plugin,
  type PluginConsentAct,
  type PluginGrant,
  type UserPlugin,
} from '@bge/database';
import { parsePluginArtifactSha256, type PluginArtifactDirectory } from '@boardgamesempire/plugin-contract';
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
import { emitDecisionEvents, type WrittenDecision } from '../consent/consent-decision-events';
import { PluginConsentActStaleError } from '../consent/plugin-consent-act.errors';
import type { ShownRisk } from '../consent/plugin-consent-act.types';
import {
  consentCatalogFlags,
  decideConsentCheck,
  type ConsentCheckDecisionInput,
} from '../consent/plugin-consent-check-classifier.service';
import { planServerAcceptance, planServerApproval, staleShownRisks } from '../consent/server-acceptance';
import { writeConsentAct } from '../consent/write-consent-act';
import { grantSnapshot, householdSwitchSnapshot, userSwitchSnapshot } from '../events/plugin-event-snapshots';
import {
  HouseholdPluginReconsentRequestedEvent,
  PluginGrantRevokedEvent,
  PluginUpdateApprovedEvent,
  PluginUpdatePendingEvent,
  PluginUpdateRejectedEvent,
  UserPluginReconsentRequestedEvent,
  type GrantedPermissionRecord,
  type PluginProvenance,
} from '../events/plugin.events';
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
import {
  disablePluginDataGatewayRow,
  findDataGatewayNameHolder,
  placePluginDataGatewayRow,
  pluginDataGatewayName,
} from '../install/plugin-data-gateway-row';
import { PluginStaticAnalysisService } from '../install/plugin-static-analysis.service';
import { gatingFindings, type StaticAnalysisReport } from '../install/static-analysis.types';
import { PluginDirectoryLayoutError } from '../loader/loader.errors';
import { PluginDirectoryResolverService } from '../loader/plugin-directory-resolver.service';
import { MODULE_OPTIONS_TOKEN, type PluginModuleOptions } from '../plugin-module.options';
import { MANIFEST_CATEGORY_TO_PRISMA } from '../registry/plugin-category.map';
import { compareForEscalations, deniedRequiredServerSlugs } from './escalation-comparator';
import { CLEARED_STAGED_UPDATE } from './staged-update.columns';
import type { ManifestComparisonView, UpdateEscalationComparison } from './update-escalation.types';
import {
  PluginUpdateActiveArtifactMovedError,
  PluginUpdateAuthorityError,
  PluginUpdateCriticalConfirmationError,
  PluginUpdateDataGatewayNameConflictError,
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
 * also drops is left to the declares diff, which names it once. Approving
 * keeps every consent decision on these permissions, and each then confers
 * nothing until a later manifest requests the permission at its scope
 * again (#1152). The staged-update read reports them, so the approval
 * screen can say what stops conferring.
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
  /** Every consent decision of the plugin, all scopes, as the comparison read them. */
  readonly decisions: readonly PluginGrant[];
}

/** What a guarded write on a plugin's staged update was doing when it matched no row (#1116). */
type LostStagedWrite =
  /** It answered a staging: an update approval or a rejection, which named this staging id. */
  | { readonly answeredStagingId: string }
  /**
   * It claimed the empty slot for this version: a staging, or an update
   * activated as it is staged. Both also held the active plugin artifact
   * they were compared against, `comparedWith` (#1096).
   */
  | { readonly claimedEmptySlotFor: string; readonly comparedWith: ComparedActiveArtifact };

/** The active plugin artifact a staging or an activation was compared against (#1096). */
interface ComparedActiveArtifact {
  /** Its checksum, which the claim holds. */
  readonly sha256: string;

  /** Its version, which a refusal names. */
  readonly version: string;
}

/** What an approval brings to the resolution: the staging it answers (#357). */
interface PendingUpdateApproval {
  readonly stagingId: string;
}

interface ResolvedPendingApproval extends ResolvedPendingUpdate {
  /**
   * The staged plugin artifact's provenance, from the staged columns, which
   * activation makes the plugin's own: its checksum becomes `installedSha256`,
   * its link `installedFromUrl` and its registry `registrySlug` (#1096).
   */
  readonly provenance: PluginProvenance;
}

export interface PluginUpdateStageInput {
  /**
   * The NEW version's plugin artifact directory. Its checksum is the one the
   * staging records as `pendingSha256` (#224), beside the link and registry
   * below; activation makes all three the plugin's provenance (#1096). This
   * service never opens the plugin artifact itself (#59).
   */
  readonly directory: PluginArtifactDirectory;

  /**
   * The link the plugin artifact was fetched from (#1096). Omitted for a
   * manual upload, which has a checksum but no link, and then the activated
   * plugin names no link, not the one its first install came from.
   */
  readonly url?: string;

  /** `PluginRegistrySource.slug` the plugin artifact was discovered through (#1096). */
  readonly registrySlug?: string;

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
  /**
   * The server-scope consent decisions the activation wrote. Empty on both
   * paths `stage()` takes: an update that activates without approval writes
   * none, and a staged one waits for `approve()` (#1336).
   */
  readonly seededGrants: readonly PluginGrant[];

  /**
   * The assessment's DataGateway name conflict when the update was staged
   * (#1096, #1083): the name is taken now and may be freed before the update
   * approval. Null when the update was activated, which a taken name refuses.
   */
  readonly dataGatewayNameConflict: string | null;
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
  /**
   * The risk the staged-update read showed for each server-scope permission
   * the staged manifest requests (#1336). A missing one, or one that is not
   * today's, refuses the approval as stale: it grants at today's risk. The
   * HTTP route always sends it; a caller that showed nothing omits it and is
   * not checked.
   */
  readonly shownRisks?: readonly ShownRisk[];
  /**
   * Exact re-entry of every Critical permission slug this approval newly
   * confers: one with no consent decision, a denied one, or one granted at a
   * risk that no longer covers today's. The same Critical confirmation
   * install demands (#59, #1336).
   */
  readonly confirmCriticalSlugs?: readonly string[];
  /**
   * The locale the server admin read the staged update's requested
   * permissions in, which the `UpdateApprove` consent act records them in
   * (#1336). Defaults to the server's default locale.
   */
  readonly locale?: string;
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
  /** The `UpdateApprove` consent act this approval recorded for the Server unit (#1336). */
  readonly act: PluginConsentAct;
  /**
   * Every server-scope consent decision this approval wrote, each naming the
   * act: the required permissions at today's risk and the optional ones the
   * Server unit had not decided (#1336).
   */
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
 * and the ones whose catalog rows it will delete. Consent decisions on a
 * removed one are kept and confer nothing without the row (#1152).
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
   * The requested permissions the update stops requesting (#577). Approving
   * keeps every consent decision on them, at every scope, and none of them
   * confers while the activated manifest does not request the permission
   * (#1152). A permission whose declaration the update removes is in
   * `declares.removed` instead.
   */
  readonly noLongerRequested: readonly string[];
  /**
   * Per scope, how many units have the plugin switched on and how many of
   * them approving would ask nothing of (#1336). Worked out by the read
   * activation uses to find who owes re-consent, so `switchedOn - covered`
   * is the number of units the approval then reports, as the decisions stand.
   */
  readonly unitCoverage: {
    readonly household: PluginUpdateUnitCoverage;
    readonly user: PluginUpdateUnitCoverage;
  };

  /**
   * The DataGateway name the update's move into data-gateway would take, when
   * another row holds it (#1083). Worked out when read, not at staging: the
   * name can be freed or taken between the staging and the update approval
   * (#1096).
   */
  readonly dataGatewayNameConflict: string | null;
}

/** How one scope's switched-on units stand against a staged update (#1336). */
export interface PluginUpdateUnitCoverage {
  /** Units with the plugin switched on at this scope. */
  readonly switchedOn: number;
  /** Of those, the units that would be asked nothing on activation. */
  readonly covered: number;
}

/** Every staging refusal an assessment can name, for the API layer to list without a second copy (#1096). */
export const PLUGIN_UPDATE_STAGING_REFUSALS = [
  'active_version',
  'staged_update_waiting',
  'active_manifest_unreadable',
  'data_gateway_name_taken',
] as const;

/**
 * Why staging an artifact would stage nothing as things stand (#1096).
 *
 * - `active_version`: the artifact is the plugin's active version. When it is
 *   the very plugin artifact the plugin runs (the same checksum), the staging
 *   route answers the plugin with 200 and writes nothing; any other artifact
 *   is refused with 409.
 * - `staged_update_waiting`: the plugin already has a staged update, which an
 *   update approval or a rejection must answer first. When the artifact is
 *   the very one staged (the same checksum), the staging route answers that
 *   staged update with 200 and writes nothing; any other artifact is refused
 *   with 409.
 * - `active_manifest_unreadable`: the plugin's stored active manifest cannot
 *   be read, so nothing can be compared against it.
 * - `data_gateway_name_taken`: the update would be activated at once, and its
 *   move into data-gateway would take a DataGateway name another row holds.
 */
export type PluginUpdateStagingRefusal = (typeof PLUGIN_UPDATE_STAGING_REFUSALS)[number];

/** What an update would change, as staging, the artifact step and the staged-update read all report it. */
export interface PluginUpdateChanges {
  readonly comparison: UpdateEscalationComparison;

  /**
   * True when nothing server-gates: staging activates the update at once,
   * unless activation then finds a required server-scope permission denied
   * under its claim and stages it for approval instead (#1336).
   */
  readonly activatesAtOnce: boolean;
  readonly declares: PluginUpdateDeclaresDiff;
  readonly noLongerRequested: readonly string[];

  /** The DataGateway name a move into data-gateway would take, when another row holds it (#1083). */
  readonly dataGatewayNameConflict: string | null;
}

/**
 * The taken DataGateway name staging refuses the update over, else null: an
 * update that would be activated at once leaves no update approval in which
 * to free the name (#1096, #1083). One expression for the refusal `stage()`
 * throws and the one `assess()` reports, so the two cannot disagree.
 */
function dataGatewayNameRefusedOver(changes: PluginUpdateChanges): string | null {
  return changes.activatesAtOnce ? changes.dataGatewayNameConflict : null;
}

export interface PluginUpdateAssessment {
  readonly activeVersion: string;

  /**
   * Why staging this artifact would stage nothing as things stand, else null
   * (#1096). For `active_version` and `staged_update_waiting`, the very
   * artifact the plugin runs or has staged (the same checksum) is answered by
   * the staging route with the current record and 200, writing nothing; any
   * other artifact is refused with 409.
   */
  readonly refusal: PluginUpdateStagingRefusal | null;

  /** Null when nothing can be compared: the artifact is the active version, or the active manifest cannot be read. */
  readonly changes: PluginUpdateChanges | null;
}

/**
 * Raised inside an activation with no approval when the Server unit's
 * decisions, read under the plugin row's claim, deny a server-scope
 * permission the next manifest requires (#1336). The throw rolls the
 * transaction back whole, the claim included, and `stage()` catches it and
 * stages the update for approval instead. Never rendered and never leaves this
 * file: it is a signal between two methods, not a refusal.
 */
class ActivationNeedsApprovalSignal extends Error {
  override readonly name = 'ActivationNeedsApprovalSignal';

  constructor(slug: string) {
    super(`Plugin '${slug}': a required server-scope permission is denied, so the update needs approval`);
  }
}

/** Covering inputs for a slug the catalog has no row for: nothing confers. */
const NO_CATALOG_ROW: Omit<ConsentCheckDecisionInput, 'grant'> = {
  currentRiskLevel: null,
  wildcardSubject: false,
  unboundedUnitScope: false,
};

/** One enabled unit that owes re-consent under the activated manifest, with the slugs it has not yet granted. */
interface ReconsentCandidate<TUnit> {
  readonly unit: TUnit;
  readonly outstanding: readonly string[];
}

/**
 * One scope's switched-on units, and those of them that owe re-consent
 * (#1336). `switchedOn` is null when the scope owes nothing, so no unit was
 * read and none was counted.
 */
interface ScopeReconsent<TUnit> {
  readonly switchedOn: number | null;
  readonly owing: ReconsentCandidate<TUnit>[];
}

/** Who owes re-consent under a manifest, at both unit scopes (#225, #1336). */
interface UnitsOwingReconsent {
  readonly household: ScopeReconsent<HouseholdPlugin>;
  readonly user: ScopeReconsent<UserPlugin>;
}

/**
 * What an approval brings to activation: the Critical confirmation it answers
 * and the locale its consent act records (#1336).
 */
interface ActivationApproval {
  readonly confirmCriticalSlugs: readonly string[];
  readonly locale: string;
}

/**
 * What one activation needs, shared by `activate()` and
 * `activateInTransaction()` so the two cannot drift apart (#1116).
 */
interface ActivationInput {
  readonly plugin: Plugin;
  readonly active: PluginManifestValidationResult;
  readonly next: PluginManifestValidationResult;

  /**
   * The provenance of the plugin artifact being activated, which becomes the
   * plugin's own: `installedSha256` (#224), `installedFromUrl` and
   * `registrySlug` (#1096).
   */
  readonly provenance: PluginProvenance;
  readonly comparison: UpdateEscalationComparison;
  readonly corePermissions: ReadonlyMap<string, Permission>;
  readonly actorId: string;
  readonly initiatedAt: Date;

  /**
   * `approve()`'s Critical confirmation and locale. Absent on the immediate
   * `stage()` path, which activates without approval: nothing server-gated,
   * so no server admin consented to anything and no act is recorded. That
   * path still reads the Server unit's decisions under the claim, and a
   * denial there of a permission `next` requires sends the update back to
   * `stage()` to be staged.
   */
  readonly approval?: ActivationApproval;
}

interface ActivationOutcome {
  readonly plugin: Plugin;
  /**
   * The server-scope requested permissions the approval granted, worked out
   * inside the transaction from the decisions read there (#1336). Empty when
   * the update activated without approval.
   */
  readonly acceptedChecks: readonly NormalizedPermissionRequest[];
  /** The consent decisions written for `acceptedChecks`, in permission order. */
  readonly acceptedGrants: readonly PluginGrant[];
  /**
   * The accepted decisions that changed a row that already stood: a denial
   * the approval overturned, or a grant it re-stamped at today's risk. Each
   * gets its grant event, which carries the row as it stood before; a
   * decision written where none stood is announced by the approval's own
   * event (#1336).
   */
  readonly changedDecisions: readonly WrittenDecision[];
  /** The approval's `UpdateApprove` consent act; null when the update activated without approval. */
  readonly act: PluginConsentAct | null;
  /** Enabled household units that owe re-consent — announced after commit, never written (#1149). */
  readonly reconsentHouseholdUnits: readonly ReconsentCandidate<HouseholdPlugin>[];
  /** The user-scope mirror (#225). */
  readonly reconsentUserUnits: readonly ReconsentCandidate<UserPlugin>[];
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
 * plugin update. The plugin artifact step and the staging service
 * (`PluginArtifactStager`, #1096) wrap `stage()` exactly as the artifact
 * installer wraps `install()` — ingress, SHA-256 verification, extraction,
 * and disk placement of the new version stay there, never in this service,
 * and removing a rejected version's directory is the plugin artifact
 * sweep's (#1094).
 *
 * `stage()` validates the new manifest (with `bgeCompat` ENFORCED — a
 * version that cannot load must not be activatable), screens it through the
 * SAME consent gates as install (categorical exclusions, core-permission
 * existence), and works out what the update would change exactly as
 * `assess()` reports it to the server admin: the escalation comparison
 * against the ACTIVE manifest, and whether a move into data-gateway would
 * take a DataGateway name another row holds (#1096). An update that would be
 * activated at once under a taken name is refused there, as install refuses
 * it. Only then does static analysis run, with its overridable
 * forbidden-specifier gate, and staging either activates immediately (no
 * server-gating escalation, and no refusal of a required server-scope
 * permission found under the activation claim) or writes the staged update's
 * columns and emits `plugin.update_pending` for the admin surface. Approving a
 * staged update is the Server unit's consent to it, recorded as one
 * `UpdateApprove` consent act (#1336).
 *
 * ACTIVATION never hot-swaps running code: the transaction promotes
 * the DB state — version, manifest, the `declares[]` catalog diff — and
 * sets `restartRequired`; the running instance continues on the prior code
 * until the next boot, where the loader clears the flag. No forced restart:
 * updating several plugins in one sitting must not bounce the server N
 * times. A real teardown path arrives with #197's worker mode.
 *
 * No consent decision is deleted by activation (#1152). A decision the new
 * manifest does not request at its scope is kept and confers nothing, and it
 * counts again, with no act, if a later manifest requests the permission at
 * that scope. Only rejecting a staged update deletes decisions: the
 * pre-consents given to that staging.
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
    private readonly auditContext: AuditContextService,
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
    // What the staging records and an activation makes the plugin's own, as
    // install builds it: the checksum is the artifact directory's (#224), and
    // a link or registry the input leaves out is null, never the first
    // install's (#1096).
    const provenance: PluginProvenance = {
      sha256: directory.sha256,
      url: input.url ?? null,
      registrySlug: input.registrySlug ?? null,
    };

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

    // The same changes `assess()` reported to the server admin, worked out by
    // the same steps, so what they were shown and what staging does cannot
    // disagree (#1096).
    const { active, corePermissions, changes } = await this.workOutChanges(plugin, next);
    let { comparison } = changes;

    // A taken name refuses an update that would be activated at once, before
    // any acknowledgement is asked for, as install refuses it (#1096, #1083).
    // An update that waits for approval is staged, since the name can be freed
    // before the approval. The activation transaction keeps its own refusal,
    // which is the one that holds against a name taken after this read.
    const takenDataGatewayName = dataGatewayNameRefusedOver(changes);

    if (takenDataGatewayName !== null) {
      throw new PluginUpdateDataGatewayNameConflictError(plugin.slug, takenDataGatewayName);
    }

    const analysis = await this.staticAnalysis.analyze(directory, { deepScan: input.deepScan ?? false });
    const acknowledgedForbiddenImports = this.resolveAnalysisGate(
      directory.slug,
      analysis,
      input.acknowledgeForbiddenImports ?? [],
    );

    // Immediate activation: nothing server-gates, a denied permission the
    // new manifest requires included (#1336). New household/user-scope
    // permissions do not hold this path — their consent is the units', and
    // activation announces the re-consent they owe (#1149).
    if (changes.activatesAtOnce) {
      const outcome = await this.activate({
        plugin,
        active,
        next,
        provenance,
        comparison,
        corePermissions,
        actorId: input.initiatorId,
        initiatedAt,
      }).catch((error: unknown) => {
        if (error instanceof ActivationNeedsApprovalSignal) {
          return null;
        }

        throw error;
      });

      if (outcome !== null) {
        this.emitActivation(plugin, outcome, provenance, next, initiatedAt);
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
          seededGrants: outcome.acceptedGrants,
          dataGatewayNameConflict: null,
        };
      }

      // A server admin denied a permission this update requires after the
      // comparison above was read, and activation found the denial under its
      // claim and rolled back (#1336). The update is staged for approval, with
      // the comparison as it now stands for the pending event. Whatever that
      // second comparison says, it is staged: an update staged that needed no
      // approval is harmless, and a loop back to activation is not.
      ({ comparison } = await this.compare(plugin, active, next, corePermissions));
    }

    const staged = await this.db.$transaction(async (tx) => {
      // Conditional on `pendingVersion` still being null INSIDE the
      // transaction. The check above reads before the write, so two
      // concurrent stages could both see an empty slot and the loser would
      // silently overwrite the winner's staged version — exactly the
      // supersede this refusal exists to prevent. `uninstalledAt` rides the
      // same guard: uninstall clears these columns, and re-arming them
      // afterwards would report a staged update against a tombstone. So does
      // the active plugin artifact the comparison was made against, as the
      // activation claim holds it: a concurrent staging that activated at
      // once leaves the slot empty, and this staging's escalations would
      // describe a manifest no longer active (#1096).
      const claimed = await tx.plugin.updateMany({
        where: { id: plugin.id, pendingVersion: null, uninstalledAt: null, installedSha256: plugin.installedSha256 },
        data: {
          pendingVersion: next.manifest.version,
          pendingManifestJson: next.manifest as Prisma.InputJsonValue,
          pendingSha256: provenance.sha256,
          // The link and registry ride with the checksum they describe, so an
          // update approval can make all three the plugin's own (#1096).
          pendingFromUrl: provenance.url,
          pendingRegistrySlug: provenance.registrySlug,
          pendingSince: initiatedAt,
          // The staging's identity (#357): fresh for every staging, even one
          // of the same version from the same artifact, so a rejection or an
          // approval aimed at an earlier staging can never match this one.
          pendingStagingId: createId(),
        },
      });

      if (claimed.count !== 1) {
        throw await this.refusalForLostStagedWrite(tx, plugin, {
          claimedEmptySlotFor: next.manifest.version,
          comparedWith: { sha256: plugin.installedSha256, version: plugin.version },
        });
      }

      return tx.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
    });

    this.emitter.emit(
      PluginUpdatePendingEvent.eventName,
      new PluginUpdatePendingEvent(
        this.stagingSnapshot(plugin),
        this.stagingSnapshot(staged),
        provenance,
        comparison.escalations,
        acknowledgedForbiddenImports,
        initiatedAt,
      ),
    );
    this.logger.log(
      `Plugin '${plugin.slug}' update ${plugin.version} → ${next.manifest.version} staged pending consent: ` +
        `${comparison.escalations.length} escalation(s)`,
    );

    return {
      plugin: staged,
      activated: false,
      comparison,
      analysis,
      warnings: next.warnings,
      acknowledgedForbiddenImports,
      seededGrants: [],
      dataGatewayNameConflict: changes.dataGatewayNameConflict,
    };
  }

  /**
   * What staging this plugin artifact would do as things stand (#1096): the
   * active version and the escalation comparison against it, whether staging
   * would activate the update at once or leave it waiting for update
   * approval, the catalog and requested-permission changes, a DataGateway
   * name a move into data-gateway would take from another row (#1083), and
   * what would refuse the staging. Null when no living plugin has the
   * directory's slug: that artifact is an install, not an update.
   *
   * The changes come from {@link changesFrom}, which `stage()` and the
   * staged-update read run too, so what the server admin is shown and what
   * staging does cannot disagree.
   *
   * The refusal follows `stage()`'s precedence: a staged update already
   * waiting first, then a taken DataGateway name for an update that would be
   * activated at once. An update that waits for approval under a taken name
   * is not refused, since the name can be freed before the update approval;
   * the name is reported in the changes.
   *
   * A read and nothing else: no actor (the caller checks authority, as for
   * `PluginInstallerService.assess`), no directory confirmation, no static
   * analysis, no transaction, no event. The new manifest is read, validated
   * and screened as `stage()` does it, without relying on the caller to have
   * screened it, so an error about it propagates. Only an active stored
   * manifest that cannot be read becomes a refusal, since the server admin
   * still needs an answer about the artifact they hold. Where the two orders
   * differ, both still refuse: with a staged update waiting, an unreadable
   * active manifest is reported here while staging answers the staged-update
   * conflict, and a new manifest that requests a forbidden permission throws
   * the forbidden-permission refusal here while staging answers the
   * staged-update conflict.
   */
  async assess(directory: PluginArtifactDirectory): Promise<PluginUpdateAssessment | null> {
    const plugin = await this.db.plugin.findUnique({ where: { slug: directory.slug } });

    if (plugin === null || plugin.uninstalledAt !== null) {
      return null;
    }

    const next = await this.readNextManifest(directory, plugin);

    if (next.manifest.version === plugin.version) {
      return { activeVersion: plugin.version, refusal: 'active_version', changes: null };
    }

    let changes: PluginUpdateChanges;

    try {
      ({ changes } = await this.workOutChanges(plugin, next));
    } catch (err) {
      // Only the ACTIVE stored manifest's failure is an answer; an error about
      // the new manifest propagates, as it does from staging.
      if (!(err instanceof PluginUpdateManifestError) || err.source !== 'active') {
        throw err;
      }

      // Named even while a staged update waits, where staging would refuse
      // over the staged update first: rejecting that update would not make
      // this artifact stageable, so the unreadable active manifest is the
      // cause the server admin has to deal with (#1096).
      return { activeVersion: plugin.version, refusal: 'active_manifest_unreadable', changes: null };
    }

    return { activeVersion: plugin.version, refusal: this.stagingRefusal(plugin, changes), changes };
  }

  /** The refusal staging would answer, in `stage()`'s order, for an update whose changes could be worked out (#1096). */
  private stagingRefusal(plugin: Plugin, changes: PluginUpdateChanges): PluginUpdateStagingRefusal | null {
    if (plugin.pendingVersion !== null) {
      return 'staged_update_waiting';
    }

    if (dataGatewayNameRefusedOver(changes) !== null) {
      return 'data_gateway_name_taken';
    }

    return null;
  }

  async approve(input: PluginUpdateApproveInput): Promise<PluginUpdateApproveResult> {
    const initiatedAt = new Date();

    if (!(await this.authority.isServerAdmin(input.approverId))) {
      throw new PluginUpdateAuthorityError(input.approverId);
    }

    const { plugin, active, next, corePermissions, comparison, decisions, provenance } =
      await this.resolvePendingUpdate(await this.loadUpdatablePlugin(input.slug), { stagingId: input.stagingId });

    // Before the Critical confirmation, whose set a stale read may also have
    // named wrong. The catalog risks here are the ones the transaction stamps,
    // so this one check covers the write (#1336).
    const staleRisks =
      input.shownRisks === undefined
        ? []
        : staleShownRisks(
            next.permissionChecks.filter((check) => check.consentScope === 'server'),
            this.riskOf(next, corePermissions),
            input.shownRisks,
          );
    if (staleRisks.length > 0) {
      throw new PluginConsentActStaleError(plugin.slug, 'risk', staleRisks);
    }

    // The Critical confirmation tracks the authority this approval CONFERS
    // (#59): a requested permission with no decision, a denied one the new
    // manifest requires, and one granted at a risk that no longer covers
    // today's. Re-approving a Low permission that became Critical hands over
    // Critical authority just as surely as granting it fresh. Judged here on
    // the decisions the comparison read, and again inside the transaction on
    // the ones read there, by the same rule (#1336).
    const { newlyConferred } = planServerApproval({
      requested: next.permissionChecks,
      decisions: decisions.filter((decision) => decision.scopeType === PluginGrantScope.Server),
      riskOf: this.riskOf(next, corePermissions),
    });
    const expectedCritical = criticalConfirmationExpectation(newlyConferred, corePermissions);
    const reentry = compareExactReentry(expectedCritical, input.confirmCriticalSlugs ?? []);

    if (!reentry.exact) {
      throw new PluginUpdateCriticalConfirmationError(plugin.slug, reentry.expected, reentry.received);
    }

    const outcome = await this.activate({
      plugin,
      active,
      next,
      provenance,
      comparison,
      corePermissions,
      actorId: input.approverId,
      initiatedAt,
      approval: {
        confirmCriticalSlugs: input.confirmCriticalSlugs ?? [],
        locale: input.locale ?? this.options.defaultLocale,
      },
    });
    const { act } = outcome;

    // activate() records the act on every approval; null is the path that
    // activates without one, which approve() never takes.
    if (act === null) {
      throw new Error(`Plugin '${plugin.slug}': the approval activated without recording its consent act`);
    }

    // The set worked out inside the transaction, not the one above: the
    // event must describe what was actually granted.
    this.emitActivation(plugin, outcome, provenance, next, initiatedAt);
    this.logger.log(
      `Plugin '${plugin.slug}' update approved: ${plugin.version} → ${next.manifest.version}, ` +
        `${outcome.acceptedGrants.length} server consent decision(s) written under act ${act.id}, ` +
        `${outcome.reconsentHouseholdUnits.length} household and ${outcome.reconsentUserUnits.length} user ` +
        `unit(s) owe re-consent; restart required`,
    );

    return {
      plugin: outcome.plugin,
      comparison,
      act,
      seededGrants: outcome.acceptedGrants,
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
   * A pure read with two deliberate asymmetries from `approve()`: no
   * server-admin re-verification (reading is not a consent act — the edge
   * guards it with `read:plugin`); and the staged checksum is not checked,
   * because only activation uses it, and refusing a corrupt one here would
   * hide a staging the server admin may want to reject (#1117). A denied
   * permission the update requires is reported as
   * `comparison.deniedRequiredSlugs`: approving grants it (#1336).
   *
   * The units that already cover the staged update are counted by
   * {@link unitsOwingReconsent}, the read activation announces re-consent
   * from, so the count and the units an approval reports cannot disagree
   * about the decisions they both read (#1336).
   */
  async describePending(slug: string): Promise<PluginUpdatePendingDescription> {
    return this.describeStaging(await this.loadUpdatablePlugin(slug));
  }

  /**
   * {@link describePending} for a plugin row the caller has already read
   * (#1096). The description is of that row's staging, with no second read,
   * so it cannot describe a staging that replaced it or refuse over one
   * resolved since: the staging service answers a repeated staging this way,
   * and its answer names the row it returns. A tombstoned row, or one with
   * nothing staged, is refused as `describePending` refuses it.
   */
  async describeStaging(plugin: Plugin): Promise<PluginUpdatePendingDescription> {
    if (plugin.uninstalledAt !== null) {
      throw new PluginUpdateTombstonedError(plugin.slug, plugin.uninstalledAt);
    }

    const { active, next, corePermissions, comparison } = await this.resolvePendingUpdate(plugin);
    const changes = await this.changesFrom(plugin, active, next, comparison);
    const owing = await this.unitsOwingReconsent(this.db, plugin.id, next, corePermissions, comparison);
    // A scope that owes nothing had its units neither read nor counted, and
    // every one of them covers the staged update.
    const switchedOn = { pluginId: plugin.id, enabled: true };
    const household = owing.household.switchedOn ?? (await this.db.householdPlugin.count({ where: switchedOn }));
    const user = owing.user.switchedOn ?? (await this.db.userPlugin.count({ where: switchedOn }));

    return {
      plugin,
      comparison: changes.comparison,
      pendingSince: plugin.pendingSince,
      declares: changes.declares,
      noLongerRequested: changes.noLongerRequested,
      unitCoverage: {
        household: { switchedOn: household, covered: household - owing.household.owing.length },
        user: { switchedOn: user, covered: user - owing.user.owing.length },
      },
      dataGatewayNameConflict: changes.dataGatewayNameConflict,
    };
  }

  /**
   * The steps `stage()` and `assess()` both take from a validated new
   * manifest to what the update would change, in one place so the two walk
   * the same sequence (#1096): the categorical permission exclusions, the
   * core permissions, the active stored manifest, the escalation comparison
   * against it, and {@link changesFrom}. An active manifest that cannot be
   * read throws `PluginUpdateManifestError` with source `'active'`, which
   * staging lets refuse and the assessment reports.
   */
  private async workOutChanges(
    plugin: Plugin,
    next: PluginManifestValidationResult,
  ): Promise<{
    readonly active: PluginManifestValidationResult;
    readonly corePermissions: ReadonlyMap<string, Permission>;
    readonly comparison: UpdateEscalationComparison;
    readonly changes: PluginUpdateChanges;
  }> {
    this.assertNoForbiddenPermissions(next);

    const corePermissions = await this.loadCorePermissions(next);
    const active = this.validateActiveManifest(plugin);
    const { comparison } = await this.compare(plugin, active, next, corePermissions);
    const changes = await this.changesFrom(plugin, active, next, comparison);

    return { active, corePermissions, comparison, changes };
  }

  /**
   * What an update would change, given its comparison against the active
   * manifest: the one function `stage()`, `assess()` and the staged-update
   * read all build their answer from (#1096), so what the server admin is
   * shown and what staging does cannot disagree. The catalog and
   * requested-permission changes come from the functions activation applies.
   *
   * The DataGateway name conflict (#1083) is asked only for a move into
   * data-gateway, since only that move places a row; a plugin that kept its
   * own row from an earlier time in the category has none. It is worked out
   * now, never stored: the name can be freed or taken at any time.
   */
  private async changesFrom(
    plugin: Plugin,
    active: PluginManifestValidationResult,
    next: PluginManifestValidationResult,
    comparison: UpdateEscalationComparison,
  ): Promise<PluginUpdateChanges> {
    const declares = declaredSlugDiff(active, next);
    const movesIntoDataGateway =
      MANIFEST_CATEGORY_TO_PRISMA[next.manifest.category] === PluginCategory.DataGateway &&
      plugin.category !== PluginCategory.DataGateway;
    let dataGatewayNameConflict: string | null = null;

    if (movesIntoDataGateway) {
      const name = pluginDataGatewayName(next.manifest, this.options.defaultLocale);

      if ((await findDataGatewayNameHolder(this.db, name, plugin.id)) !== null) {
        dataGatewayNameConflict = name;
      }
    }

    return {
      comparison,
      activatesAtOnce: !comparison.serverGating,
      declares,
      noLongerRequested: requestedSlugsDropped(active, next, declares.removed),
      dataGatewayNameConflict,
    };
  }

  async reject(input: PluginUpdateRejectInput): Promise<Plugin> {
    const initiatedAt = new Date();

    if (!(await this.authority.isServerAdmin(input.rejectorId))) {
      throw new PluginUpdateAuthorityError(input.rejectorId);
    }

    const plugin = await this.loadUpdatablePlugin(input.slug);

    this.assertAnswersCurrentStaging(plugin, input.stagingId);

    const stagedVersion = plugin.pendingVersion;

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
    const { rejected, preConsents } = await this.db.$transaction(async (tx) => {
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
        throw await this.refusalForLostStagedWrite(tx, plugin, { answeredStagingId: input.stagingId });
      }

      // Read back INSIDE the claim, like the staging and activation writes:
      // the guarded updateMany returns a count, not the row. The clear leaves
      // `pendingVersion` null, which is exactly the slot stage() claims on,
      // so an outside read-back can observe a NEWLY staged version — handing
      // this response, and the rejected event's `after` snapshot, a staged
      // update nobody rejected.
      const rejected = await tx.plugin.findUniqueOrThrow({ where: { id: plugin.id } });

      // The pre-consents households and users gave to this staged update go
      // with it (#1150). Left in place, a later update that requests the same
      // permission would find it already granted, a consent nobody gave to
      // that update. A pre-consent is a consent decision whose act names this
      // staging (#1152): a staged review records the staging it answered, and
      // may only grant a permission the active manifest does not request at
      // the unit's scope, so those decisions are exactly the pre-consents.
      // Any other decision names an act that answered no staging (one on the
      // active manifest) or another staging (an earlier approval's), whatever
      // its permission, and stays. No manifest is read to tell them apart, so
      // a rejection over an active manifest that no longer validates deletes
      // them all the same. A pre-consent is a household's or user's consent
      // decision, and the Server unit answers a staged update by approving
      // it, so an approval's act, which names the staging it consumed, is
      // never matched and a rejection cannot reach the Server unit's
      // decisions.
      //
      // The acts are matched on `input.stagingId`, the string
      // `assertAnswersCurrentStaging` proved equal to the row's staging id
      // and the clear above matched: never on a value that could be null,
      // since a null staging id matches every act on the active manifest.
      //
      // Read and deleted under the claim above, which holds the plugin row.
      // A staged review claims that row `FOR SHARE` before it writes, so one
      // in flight either committed first, and its decisions are read here,
      // or waits for this transaction and is then refused: its sha is no
      // longer the staged one. Read before the delete, because the
      // revocation events are the only durable record of what went.
      const stagingActs = await tx.pluginConsentAct.findMany({
        where: {
          pluginId: plugin.id,
          stagingId: input.stagingId,
          scopeType: { in: [PluginGrantScope.Household, PluginGrantScope.User] },
        },
        select: { id: true },
      });

      // Most stagings are rejected with no staged review on record, and
      // then no decision can name one of their acts.
      if (stagingActs.length === 0) {
        return { rejected, preConsents: [] };
      }

      const preConsents = await tx.pluginGrant.findMany({
        where: { pluginId: plugin.id, actId: { in: stagingActs.map((act) => act.id) } },
      });

      if (preConsents.length > 0) {
        await tx.pluginGrant.deleteMany({ where: { id: { in: preConsents.map((grant) => grant.id) } } });
      }

      return { rejected, preConsents };
    });

    // Removing the staged artifact's directory, once no living row names it,
    // is the plugin artifact sweep's job (#1094, #224); this service never
    // touches the filesystem beyond reading manifests (#59).
    this.emitter.emit(
      PluginUpdateRejectedEvent.eventName,
      new PluginUpdateRejectedEvent(this.stagingSnapshot(plugin), this.stagingSnapshot(rejected), initiatedAt),
    );

    for (const grant of preConsents) {
      this.emitter.emit(
        PluginGrantRevokedEvent.eventName,
        new PluginGrantRevokedEvent(
          grantSnapshot(grant),
          'staged-update-rejected',
          // The pre-consent was given to the staged manifest, not the active one.
          { manifestVersion: stagedVersion, actId: grant.actId },
          initiatedAt,
        ),
      );
    }

    this.logger.log(
      `Plugin '${plugin.slug}' pending update ${stagedVersion} rejected and cleared, ` +
        `${preConsents.length} pre-consent(s) deleted`,
    );

    return rejected;
  }

  /**
   * The shared approve/describe prologue, from a living plugin row the
   * caller loaded (the not-found and tombstoned distinctions are the
   * caller's): the no-pending distinction, re-validate both
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
   * An approval passes the staging it answers, and gets the staged
   * provenance back as well, its checksum checked (#357, #1117, #1096). The
   * staged-update read passes neither.
   */
  private resolvePendingUpdate(plugin: Plugin): Promise<ResolvedPendingUpdate>;
  private resolvePendingUpdate(plugin: Plugin, approval: PendingUpdateApproval): Promise<ResolvedPendingApproval>;
  private async resolvePendingUpdate(
    plugin: Plugin,
    approval?: PendingUpdateApproval,
  ): Promise<ResolvedPendingUpdate & { readonly provenance?: PluginProvenance }> {
    // A staged row without its checksum names no plugin artifact, so there
    // is nothing approval could activate (#696): it is not a staged update.
    if (plugin.pendingVersion === null || plugin.pendingManifestJson === null || plugin.pendingSha256 === null) {
      throw new PluginUpdateNoPendingError(plugin.slug);
    }

    // Before the staged manifest is validated or compared: a staging the
    // approver never saw is refused for that, whatever else is wrong with it.
    if (approval !== undefined) {
      this.assertAnswersCurrentStaging(plugin, approval.stagingId);
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
    const { comparison, decisions } = await this.compare(plugin, active, next, corePermissions);

    // The staged link and registry ride with the checksum they describe
    // (#1096); only an approval activates them, so only an approval gets them.
    const provenance: PluginProvenance | undefined =
      pendingSha256 === undefined
        ? undefined
        : { sha256: pendingSha256, url: plugin.pendingFromUrl, registrySlug: plugin.pendingRegistrySlug };

    return { plugin, active, next, corePermissions, comparison, decisions, provenance };
  }

  /**
   * Refuses an update approval or a rejection that does not answer the staging
   * currently in the row: no staged update is `PluginUpdateNoPendingError`, a
   * staging id that whoever approves or rejects never saw is
   * `PluginUpdateStagingReplacedError`. One home for the check, so approve and
   * reject cannot drift apart (#357, #1116).
   */
  private assertAnswersCurrentStaging(
    plugin: Plugin,
    stagingId: string,
  ): asserts plugin is Plugin & { pendingVersion: string } {
    if (plugin.pendingVersion === null) {
      throw new PluginUpdateNoPendingError(plugin.slug);
    }

    if (plugin.pendingStagingId !== stagingId) {
      throw new PluginUpdateStagingReplacedError(plugin.slug, stagingId);
    }
  }

  /**
   * Why a guarded write on a plugin's staged update matched no row, given what
   * the write was doing. Re-reads the row through `tx`, so the answer comes
   * from the state the write lost to.
   *
   * An uninstalled plugin always gets `PluginUpdateTombstonedError`. A write
   * that answered a staging (an update approval, a rejection) finds it
   * consumed or gone (`PluginUpdateNoPendingError`) or replaced by another
   * staging (`PluginUpdateStagingReplacedError`, #357): nothing is left for it
   * to resolve. A write that claimed an empty slot (the staging write, or an
   * activation with nothing staged) and finds a staged update there lost it to
   * a concurrent stage and gets `PluginUpdatePendingConflictError`, the
   * refuse-don't-supersede answer, built from the version now staged (#1116).
   *
   * An empty-slot claim also held the active plugin artifact it was compared
   * against, by its checksum (#1096). When it finds nothing staged and another
   * checksum installed, it lost to an activation: one that made the version
   * being claimed for active, as from a double click, gets
   * `PluginUpdateVersionConflictError`, and any other gets
   * `PluginUpdateActiveArtifactMovedError`, since the comparison it was
   * staged or activated on is stale. An empty-slot claim nothing explains
   * keeps the staged-update conflict, its staged version unknown.
   */
  private async refusalForLostStagedWrite(
    tx: Prisma.TransactionClient,
    plugin: Pick<Plugin, 'id' | 'slug'>,
    write: LostStagedWrite,
  ): Promise<Error> {
    const current = await tx.plugin.findUnique({
      where: { id: plugin.id },
      select: {
        uninstalledAt: true,
        pendingVersion: true,
        pendingStagingId: true,
        installedSha256: true,
        version: true,
      },
    });

    if (current?.uninstalledAt != null) {
      return new PluginUpdateTombstonedError(plugin.slug, current.uninstalledAt);
    }

    if ('answeredStagingId' in write) {
      if (current?.pendingStagingId != null && current.pendingStagingId !== write.answeredStagingId) {
        return new PluginUpdateStagingReplacedError(plugin.slug, write.answeredStagingId);
      }

      return new PluginUpdateNoPendingError(plugin.slug);
    }

    if (current !== null && current.pendingVersion === null && current.installedSha256 !== write.comparedWith.sha256) {
      if (current.version === write.claimedEmptySlotFor) {
        return new PluginUpdateVersionConflictError(plugin.slug, write.claimedEmptySlotFor);
      }

      return new PluginUpdateActiveArtifactMovedError(plugin.slug, write.comparedWith.version, current.version);
    }

    return new PluginUpdatePendingConflictError(
      plugin.slug,
      current?.pendingVersion ?? 'unknown',
      write.claimedEmptySlotFor,
    );
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

  /** `stage()`'s reading of the new manifest: {@link readNextManifest}, and the active version refused. */
  private async validateNextManifest(
    directory: PluginArtifactDirectory,
    plugin: Plugin,
  ): Promise<PluginManifestValidationResult> {
    const next = await this.readNextManifest(directory, plugin);

    if (next.manifest.version === plugin.version) {
      throw new PluginUpdateVersionConflictError(plugin.slug, plugin.version);
    }

    return next;
  }

  /**
   * Reads and validates the new version's manifest from its plugin artifact
   * directory, with `bgeCompat` ENFORCED, and refuses a slug that renames the
   * plugin. One reader for `stage()` and `assess()`, so the assessment judges
   * the manifest staging would (#1096); the active version is left to each,
   * since staging refuses it and the assessment reports it.
   */
  private async readNextManifest(
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

  /** The escalation comparison, and the consent decisions it was computed from. */
  private async compare(
    plugin: Plugin,
    active: PluginManifestValidationResult,
    next: PluginManifestValidationResult,
    corePermissions: ReadonlyMap<string, Permission>,
  ): Promise<{ readonly comparison: UpdateEscalationComparison; readonly decisions: readonly PluginGrant[] }> {
    const decisions = await this.db.pluginGrant.findMany({ where: { pluginId: plugin.id } });
    const currentRiskBySlug = this.currentRiskBySlug(next, corePermissions);

    const comparison = compareForEscalations({
      active: this.comparisonView(active),
      next: this.comparisonView(next),
      grants: decisions.map((grant) => ({
        permissionSlug: grant.permissionSlug,
        scopeType: grant.scopeType,
        status: grant.status,
        decidedRiskLevel: grant.decidedRiskLevel,
      })),
      currentRiskBySlug,
    });

    return { comparison, decisions };
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

  /** Today's catalog risk of a requested permission of `next`, as {@link currentRiskBySlug} reads it. */
  private riskOf(
    next: PluginManifestValidationResult,
    corePermissions: ReadonlyMap<string, Permission>,
  ): (check: NormalizedPermissionRequest) => RiskLevel {
    const bySlug = this.currentRiskBySlug(next, corePermissions);

    return (check) => bySlug.get(check.canonicalSlug) ?? RiskLevel.Low;
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

  /**
   * The activation entry point: warms the next manifest's config schema, then
   * runs the activation transaction once. Nothing is retried. The signal that
   * an update needs approval goes straight back to `stage()`, which stages it
   * (#1336), and a deadlock reaches the client as the API's retryable 409
   * (#1152).
   */
  private async activate(input: ActivationInput): Promise<ActivationOutcome> {
    const { next } = input;

    // Compiled here rather than inside the transaction: the retained server
    // config validation below runs holding the claimed row, and ajv's codegen
    // has no business inside that window (mirrors `install()`'s own warm
    // call).
    this.configSchema.warm({
      slug: next.manifest.slug,
      version: next.manifest.version,
      schema: next.manifest.config.schema,
    });

    return this.activateInTransaction(input);
  }

  /**
   * The activation transaction, shared by the immediate path and
   * `approve()`: promote the pending state, apply the `declares[]` catalog
   * diff (insert added rows at Low, delete the rows of removed declares),
   * record an approval's `UpdateApprove` consent act and the server-scope
   * consent decisions it grants (#1336), work out which enabled household AND
   * user units do not cover their scope's re-consent slugs (#225) — a read,
   * never a write to their rows (#1149) — and set `restartRequired`. It
   * deletes no consent decision: one the new manifest does not request at
   * its scope is kept and confers nothing (#1152). Events, the re-consent
   * announcements among them, are collected inside and emitted by the caller
   * AFTER commit.
   */
  private async activateInTransaction(input: ActivationInput): Promise<ActivationOutcome> {
    const { plugin, active, next, provenance, comparison, corePermissions, actorId, initiatedAt, approval } = input;

    // Outside the transaction: none of it reads the database.
    const correlationId = approval === undefined ? null : (this.auditContext.getCorrelationId() ?? null);
    const riskOf = this.riskOf(next, corePermissions);

    return this.db.$transaction(async (tx) => {
      // Row-LOCKED, not a plain read (D-CN). `PluginLifecycleService.updateConfig`
      // is a plain UPDATE with no version precondition ("last-writer-wins by
      // decision") targeting the same living-row state (`uninstalledAt: null`)
      // the claim below does. An unlocked read here could snapshot `config`
      // right before that PATCH commits, and the write below would then
      // silently overwrite the admin's fresh document with the stale one —
      // worse than ordinary last-writer-wins, since the write that "wins"
      // was never the actual last writer's intent. `FOR UPDATE` makes the two
      // mutually exclusive: the PATCH's UPDATE either commits before this
      // SELECT (and is read here) or blocks until this transaction commits
      // (and lands after activation). The same lock is what orders every
      // writer of a server-scope consent decision behind this transaction:
      // each claims this row `FOR SHARE` first (#398, #1336). Raw SQL because
      // Prisma's query API cannot express FOR UPDATE; unqualified table name
      // so the search_path (per-worker test schemas) resolves it. Placed
      // first in the transaction, ahead of the grant rows the approval
      // writes: every writer of consent decisions takes the plugin row
      // before them.
      const [current] = await tx.$queryRaw<{ config: Prisma.JsonValue; category: PluginCategory }[]>`
        SELECT config, category FROM plugins WHERE id = ${plugin.id} FOR UPDATE`;

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
      // The claim also holds that the active plugin artifact is still the one
      // this activation was compared against, by its checksum (#1096). With
      // nothing staged, the staged columns are null before and after an
      // activation, so two stagings that both decided to activate at once
      // would both match them, and the second would activate again, or
      // activate a comparison made against a manifest no longer active. A
      // version number would not do: an update may move to any other version,
      // an earlier one included, so a number can come back with other
      // content, and a checksum of other content cannot. A reinstall from
      // another plugin artifact inside the window moves the checksum too, so
      // the guard refuses it (#1096). A reinstall from the same artifact has
      // the same manifest but fresh grants, and that older race is not closed
      // here.
      const claimed = await tx.plugin.updateMany({
        where: {
          id: plugin.id,
          uninstalledAt: null,
          pendingVersion: plugin.pendingVersion,
          pendingStagingId: plugin.pendingStagingId,
          installedSha256: plugin.installedSha256,
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
          // checksum on the next boot (#224). The link and registry follow it,
          // so the row's provenance describes the active version, never the
          // first install's (#1096).
          installedSha256: provenance.sha256,
          installedFromUrl: provenance.url,
          registrySlug: provenance.registrySlug,
          ...CLEARED_STAGED_UPDATE,
          // The running instance is still the prior code; the loader
          // clears this on the boot that actually loads the new version.
          restartRequired: true,
        },
      });

      if (claimed.count !== 1) {
        // The staged state or the active plugin artifact moved. An approval's
        // staged update was consumed or replaced, while the immediate stage()
        // path lost the empty slot to a concurrent stage, or lost the active
        // plugin artifact it was compared against to a concurrent activation
        // (#1096). The database keeps the five staged columns all null or all
        // set (`plugins_staged_update_all_or_nothing`), so a row's staging id
        // is not null exactly when it had a staged update (#1116).
        throw await this.refusalForLostStagedWrite(
          tx,
          plugin,
          plugin.pendingStagingId !== null
            ? { answeredStagingId: plugin.pendingStagingId }
            : {
                claimedEmptySlotFor: next.manifest.version,
                comparedWith: { sha256: plugin.installedSha256, version: plugin.version },
              },
        );
      }

      // The plugin's DataGateway row follows a move into or out of the
      // data-gateway category, which the claim just wrote (#1083). Into it,
      // the row is placed as an install places it: created, or enabled when
      // the plugin kept one from an earlier time in the category. Out of it,
      // the row is disabled and kept, as an uninstall leaves it, with the
      // game sources that hang on it. An update that stays on one side of
      // that edge touches no row, so a DataGateway an admin disabled stays
      // disabled through its plugin's updates. Under the claim, the insert's
      // foreign key locks a plugin row this transaction already holds, and a
      // name that is taken takes the whole activation back.
      //
      // The category it leaves is the one read under the lock above, not the
      // one on the row loaded before it. The claim holds the staged update and
      // the active plugin artifact, not the category, so the category is read
      // where nothing else can move it.
      const wasDataGateway = current.category === PluginCategory.DataGateway;
      const becomesDataGateway = MANIFEST_CATEGORY_TO_PRISMA[next.manifest.category] === PluginCategory.DataGateway;

      if (becomesDataGateway && !wasDataGateway) {
        await placePluginDataGatewayRow(tx, {
          pluginId: plugin.id,
          name: pluginDataGatewayName(next.manifest, this.options.defaultLocale),
          installerId: actorId,
          nameTaken: (name) => new PluginUpdateDataGatewayNameConflictError(plugin.slug, name),
        });
      } else if (wasDataGateway && !becomesDataGateway) {
        await disablePluginDataGatewayRow(tx, plugin.id);
      }

      // The Server unit's decisions as they stand under the claim, read on
      // both paths (#1336). The caller decided from the comparison's read,
      // taken before this transaction opened, and a server consent act can
      // land in between. Without an approval, a denial on a server-scope
      // permission the next manifest requires means the update needs one: the
      // signal rolls this transaction back and `stage()` stages the update
      // instead. With an approval, the approval's rule is applied to these
      // decisions, and here is where its answer is decided.
      //
      // A plain read is stable: this transaction holds the plugin row
      // `FOR UPDATE`, and every other writer of a server-scope decision (a
      // server consent act) claims that row `FOR SHARE` before it writes, so
      // it either committed before the claim above, and is read here, or waits
      // for this transaction to commit, and its own claim then compares the
      // sha and refuses the moved manifest (#361, #1336).
      const serverDecisions = await tx.pluginGrant.findMany({
        where: { pluginId: plugin.id, scopeType: PluginGrantScope.Server, scopeId: SERVER_SCOPE_SENTINEL },
      });
      const serverDecisionsBySlug = new Map(serverDecisions.map((row) => [row.permissionSlug, row]));
      let acceptedChecks: readonly NormalizedPermissionRequest[] = [];

      if (approval === undefined) {
        if (deniedRequiredServerSlugs(next.permissionChecks, serverDecisions).length > 0) {
          throw new ActivationNeedsApprovalSignal(plugin.slug);
        }
      } else {
        const serverApproval = planServerApproval({
          requested: next.permissionChecks,
          decisions: serverDecisions,
          riskOf,
        });

        // The Critical confirmation, asked again of what this transaction
        // confers: a decision that landed since approve() asked it can grow or
        // shrink that set, and a confirmation for another set no longer
        // matches, so the approval is re-challenged with the current
        // expectation, the same exact-re-entry answer approve() gives before
        // the transaction.
        const expectedCritical = criticalConfirmationExpectation(serverApproval.newlyConferred, corePermissions);
        const confirmation = compareExactReentry(expectedCritical, approval.confirmCriticalSlugs);

        if (!confirmation.exact) {
          throw new PluginUpdateCriticalConfirmationError(plugin.slug, confirmation.expected, confirmation.received);
        }

        acceptedChecks = serverApproval.accepted;
      }

      const { added: addedDeclares, removed: removedDeclares } = declaredSlugDiff(active, next);

      // The catalog follows `declares[]`: a permission the plugin stops
      // declaring loses its catalog row, and one it declares (again) gets
      // one. No consent decision is deleted, here or anywhere in activation
      // (#1152). A decision the next manifest does not request at its scope,
      // because the plugin stopped declaring or requesting the permission or
      // moved it to another consent scope, is kept and confers nothing: the
      // ability is bounded by the active manifest's requested permissions
      // when read (#577), and a plugin-declared one also needs its catalog
      // row. It counts again, with no act, if a later manifest requests the
      // permission at that scope.
      if (removedDeclares.length > 0) {
        // Copied because Prisma's `in` takes a mutable array and the diff is
        // shared with the read that renders it, which must not hand out one.
        await tx.pluginPermission.deleteMany({ where: { pluginId: plugin.id, slug: { in: [...removedDeclares] } } });
      }

      for (const slug of addedDeclares) {
        await tx.pluginPermission.create({
          // Explicit Low, never the manifest and never a schema default (#59).
          data: { pluginId: plugin.id, slug, riskLevel: RiskLevel.Low },
        });
      }

      // The approval's consent act and the decisions it carries. A decision
      // on a permission whose consent scope moved to server is written at the
      // Server unit's coordinates, which no decision at the scope it left
      // shares.
      let act: PluginConsentAct | null = null;
      const acceptedGrants: PluginGrant[] = [];
      const changedDecisions: WrittenDecision[] = [];

      if (approval !== undefined) {
        const acceptance = planServerAcceptance({
          accepted: acceptedChecks,
          shown: next.permissionChecks.filter((check) => check.consentScope === 'server'),
          riskOf,
          source: 'staged',
          locale: approval.locale,
          defaultLocale: this.options.defaultLocale,
        });

        // The acceptance's decisions are in permission order. The standing
        // rows are the ones read under the claim.
        const written = await writeConsentAct(tx, {
          pluginId: plugin.id,
          pluginSlug: plugin.slug,
          scopeType: PluginGrantScope.Server,
          scopeId: SERVER_SCOPE_SENTINEL,
          kind: PluginConsentActKind.UpdateApprove,
          manifestVersion: next.manifest.version,
          manifestSha256: provenance.sha256,
          // The staging the approval answered, which the claim above held.
          stagingId: plugin.pendingStagingId,
          presentation: acceptance.presentation,
          decisions: acceptance.decisions,
          standingBySlug: serverDecisionsBySlug,
          actorId,
          decidedAt: initiatedAt,
          correlationId,
        });

        act = written.act;
        acceptedGrants.push(...written.rows);
        // A decision the approval writes fresh is announced by
        // `plugin.update_approved`, so only a row that stood before is
        // announced as a decision change.
        changedDecisions.push(...written.changed.filter(({ before }) => before !== null));
      }

      const updated = await tx.plugin.findUniqueOrThrow({ where: { id: plugin.id } });

      // Who owes re-consent is worked out here and announced after commit;
      // nothing is written to any unit enablement (#1149). A unit that has
      // not answered keeps running on the grants it gave, and its consent
      // standing is worked out when read, so there is no state here to keep
      // current — and no lock on the enablement to take. The approval
      // surface counts its covered units with the same method (#1336).
      const owing = await this.unitsOwingReconsent(tx, plugin.id, next, corePermissions, comparison);

      return {
        plugin: updated,
        acceptedChecks,
        acceptedGrants,
        changedDecisions,
        act,
        reconsentHouseholdUnits: owing.household.owing,
        reconsentUserUnits: owing.user.owing,
        retainedConfigReset: retainedConfig.reset,
      };
    });
  }

  /**
   * Post-commit emissions, matching the commit-then-emit discipline everywhere
   * else. `provenance` is the one the activation wrote, passed in rather than
   * read back off the row, so the event cannot announce another (#1096).
   */
  private emitActivation(
    before: Plugin,
    outcome: ActivationOutcome,
    provenance: PluginProvenance,
    next: PluginManifestValidationResult,
    initiatedAt: Date,
  ): void {
    // The set worked out inside the transaction: a decision that landed since
    // approve()'s own read may have changed it, and the event must describe
    // what was actually granted (#1336).
    const grantedPermissions: GrantedPermissionRecord[] = outcome.acceptedChecks.map((check) => ({
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
        provenance,
        grantedPermissions,
        outcome.retainedConfigReset,
        outcome.act?.id ?? null,
        initiatedAt,
      ),
    );

    // A decision the approval changed on a row that already stood, a denial
    // overturned above all, is a decision change like any server consent
    // act's, and announces itself the same way (#1336). Only an approval
    // writes decisions, so there is an act whenever there is one to announce.
    if (outcome.act !== null) {
      emitDecisionEvents(
        this.emitter,
        outcome.changedDecisions,
        { manifestVersion: next.manifest.version, actId: outcome.act.id },
        initiatedAt,
      );
    }

    // One announcement per unit that owes re-consent (#1149): the durable,
    // notifiable record that a household admin or user has a review pending.
    // The unit enablement did not change, so each event carries one snapshot.
    for (const candidate of outcome.reconsentHouseholdUnits) {
      this.emitter.emit(
        HouseholdPluginReconsentRequestedEvent.eventName,
        new HouseholdPluginReconsentRequestedEvent(
          householdSwitchSnapshot(candidate.unit),
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
          userSwitchSnapshot(candidate.unit),
          candidate.outstanding,
          next.manifest.version,
          initiatedAt,
        ),
      );
    }
  }

  /**
   * Who owes re-consent under `next`, at both unit scopes, and how many units
   * each scope has switched on. Activation calls it inside its transaction to
   * announce re-consent, and the staged-update read calls it outside one to
   * count the units already covered, so the two cannot disagree (#1336).
   * Whether a Granted row still covers is `decideConsentCheck`, the rule the
   * consent standing and the consent surface read, so a unit the standing
   * reads as owing is a unit counted as owing here (#1149).
   *
   * Switched-on units only, whether or not they can currently run. A
   * switched-off unit accepts the whole required set afresh when it switches
   * on again, so the announcement would tell it nothing it is not asked then.
   * A switched-on unit that cannot run under this manifest (its scope has no
   * household surface, or its retained configuration fails the schema) is
   * still switched on: whether it can run is worked out when read (#1151), it
   * is asked nothing when that is cured, and it would otherwise read
   * review_pending without ever having been told. Nothing is judged at
   * switch-on: the standing is read whenever feature state, the inventory or
   * the ability read it, so a unit switched on after activation shows
   * review_pending but is never announced (#1149). Users with no unit
   * enablement never appear: no row means not enabled, so there is nobody to
   * tell (#225).
   *
   * A scope with no re-consent slugs owes nothing, so its units are neither
   * read nor counted here: activation holds the plugin row `FOR UPDATE` and
   * has no use for the count, so the staged-update read counts them itself.
   * Fixed query count regardless of how many units run the plugin: at most
   * one unit read and one grant read per scope. A per-unit loop put
   * activation's duration on the number of installs, and exceeding the
   * interactive-transaction timeout would roll back the whole update —
   * failing an activation because the plugin was POPULAR.
   */
  private async unitsOwingReconsent(
    client: Prisma.TransactionClient | DatabaseService,
    pluginId: string,
    next: PluginManifestValidationResult,
    corePermissions: ReadonlyMap<string, Permission>,
    comparison: UpdateEscalationComparison,
  ): Promise<UnitsOwingReconsent> {
    const switchedOn = { pluginId, enabled: true };
    // decidedRiskLevel is load-bearing, not decoration: for a risk
    // escalation the Granted row EXISTS by definition — its stale risk is
    // what escalated — so treating presence as consent would silently skip
    // every risk-escalated unit.
    const grantedSelect = { scopeId: true, permissionSlug: true, decidedRiskLevel: true } as const;

    let household: ScopeReconsent<HouseholdPlugin>;

    if (comparison.householdReconsentSlugs.length === 0) {
      household = { switchedOn: null, owing: [] };
    } else {
      const units = await client.householdPlugin.findMany({ where: switchedOn });
      const granted =
        units.length === 0
          ? []
          : await client.pluginGrant.findMany({
              where: {
                pluginId,
                scopeType: PluginGrantScope.Household,
                scopeId: { in: units.map((unit) => unit.householdId) },
                status: PluginGrantStatus.Granted,
                permissionSlug: { in: [...comparison.householdReconsentSlugs] },
              },
              select: grantedSelect,
            });

      household = {
        switchedOn: units.length,
        owing: this.reconsentCandidates({
          units,
          scopeIdOf: (unit) => unit.householdId,
          granted,
          reconsentSlugs: comparison.householdReconsentSlugs,
          coverage: this.coverageInputs(next, corePermissions, PluginGrantScope.Household),
        }),
      };
    }

    // The user-scope mirror (#225): identical shape against `UserPlugin`.
    let user: ScopeReconsent<UserPlugin>;

    if (comparison.userReconsentSlugs.length === 0) {
      user = { switchedOn: null, owing: [] };
    } else {
      const units = await client.userPlugin.findMany({ where: switchedOn });
      const granted =
        units.length === 0
          ? []
          : await client.pluginGrant.findMany({
              where: {
                pluginId,
                scopeType: PluginGrantScope.User,
                scopeId: { in: units.map((unit) => unit.userId) },
                status: PluginGrantStatus.Granted,
                permissionSlug: { in: [...comparison.userReconsentSlugs] },
              },
              select: grantedSelect,
            });

      user = {
        switchedOn: units.length,
        owing: this.reconsentCandidates({
          units,
          scopeIdOf: (unit) => unit.userId,
          granted,
          reconsentSlugs: comparison.userReconsentSlugs,
          coverage: this.coverageInputs(next, corePermissions, PluginGrantScope.User),
        }),
      };
    }

    return { household, user };
  }

  /**
   * Which units of one scope owe re-consent under `next` — a pure function,
   * shared by the household and user halves of {@link unitsOwingReconsent}
   * so the covering predicate cannot drift between scopes. A slug is
   * outstanding unless the unit's Granted row still confers under
   * `decideConsentCheck`, the same rule the consent standing reads (#1149): a
   * unit that granted a new permission on the staged manifest ahead of time,
   * at a covering risk, owes nothing.
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
}
