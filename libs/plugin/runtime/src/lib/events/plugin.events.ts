import type { PluginUnit } from '@bge/actor-context';
import { MutationEvent } from '@bge/actor-context';
import type { HouseholdPlugin, Plugin, PluginGrant, UserPlugin } from '@bge/database';
import { ResourceType } from '@bge/database';
import type { PluginArtifactSha256 } from '@boardgamesempire/plugin-contract';
import { PluginEvent } from '@boardgamesempire/plugin-contract';
import type { PluginConsentScopeValue } from '@boardgamesempire/plugin-manifest';
import type { StaticAnalysisFinding } from '../install/static-analysis.types';
import type { UpdateEscalation } from '../update/update-escalation.types';

/**
 * Plugin lifecycle events (#59).
 *
 * Every lifecycle transition IS a row mutation on `Plugin`,
 * `HouseholdPlugin`, or `PluginGrant`, so these extend `MutationEvent` and
 * ride the existing default-auditable pipeline (#57) into `AuditLog` with
 * zero new plumbing — actor/source/correlationId come from CLS at handle
 * time, snapshots are diffed by the audit listener. The dedicated
 * `plugin_lifecycle_events` table (long-lived provenance, no retention
 * sweep) is fed by a Phase B listener on `PLUGIN_EVENT_WILDCARD` that maps
 * classes via `PLUGIN_EVENT_TO_LIFECYCLE_TYPE` and persists the
 * lifecycle-specific CONTEXT fields below (provenance, grants, audit
 * findings) which deliberately stay off the before/after snapshots and
 * therefore out of `AuditLog.payload`.
 */

/**
 * Where a plugin artifact came from: its link, checksum and registry (#84).
 * It describes the artifact a plugin was installed from, the one a staged
 * update carries, and the one an update approval made active (#1096). A
 * plugin artifact always has a checksum (#696). The names are the ones the
 * client reads (#1117), so the event, the lifecycle payload and the inventory
 * read share one shape.
 */
export interface PluginProvenance {
  readonly registrySlug: string | null;
  readonly sha256: PluginArtifactSha256;
  readonly url: string | null;
}

/** One consent decision captured at install time — `reason` is resolved to the server default locale. */
export interface GrantedPermissionRecord {
  readonly consentScope: PluginConsentScopeValue;
  readonly reason: string;
  readonly required: boolean;
  readonly slug: string;
}

/**
 * Minimal npm-advisory finding recorded alongside an install (#84 step 5).
 * Shape intentionally small; #84 owns the full report and may extend this.
 */
export interface NpmAuditFinding {
  readonly advisoryUrl: string;
  readonly module: string;
  readonly severity: 'low' | 'moderate' | 'high' | 'critical';
}

type PluginInstalledSnapshot = Readonly<Pick<Plugin, 'id' | 'slug' | 'version' | 'category' | 'scope' | 'enabled'>>;

/**
 * The install-specific context an installed event carries beyond the row
 * snapshot. A single object rather than a growing positional tail: the
 * pipeline has already added static-analysis findings and the override
 * record, and #84's npm audit step extends this shape too — each of those
 * would otherwise be another argument nobody can read at the call site.
 * Reads stay flat (`event.provenance`), so consumers are unaffected.
 */
export interface PluginInstallAuditContext {
  /**
   * Forbidden import specifiers the installing admin explicitly accepted to
   * get past the static-analysis gate — empty on an ordinary install.
   *
   * Recorded as its own field rather than left to be inferred from the
   * presence of forbidden findings above: "was this install overridden, and
   * what exactly was waved through" is a question an operator will ask of
   * the lifecycle table directly, and reconstructing it from a rule about
   * which findings can coexist with an installed row is the same implicit
   * reconstruction `decidedRiskLevel` exists to avoid on grant rows.
   */
  readonly acknowledgedForbiddenImports: readonly string[];

  /**
   * The `InstallAccept` consent act the install recorded (#1336), so the
   * lifecycle row names the act that holds what the server admin was shown.
   */
  readonly actId: string;

  /** npm advisory findings acknowledged at install, `null` when no lockfile was present (#84). */
  readonly auditFindings: readonly NpmAuditFinding[] | null;

  /** Server-consentable permissions granted by the installing admin. */
  readonly grantedPermissions: readonly GrantedPermissionRecord[];

  /** Ingress provenance — context for the lifecycle table, not row state. */
  readonly provenance: PluginProvenance;

  /**
   * A reinstall over a tombstone found the retained server config invalid
   * under the NEW manifest's `config.schema` and reset it to `{}` —
   * "did my old settings survive the reinstall" is answered here, not
   * reconstructed from row state. Always false on a fresh install; optional
   * so pre-reinstall construction sites need no churn.
   */
  readonly retainedConfigReset?: boolean;

  /** Everything static analysis reported: warnings, deep-scan advisories, and any overridden forbidden imports. */
  readonly staticAnalysis: readonly StaticAnalysisFinding[];
}

export class PluginInstalledEvent extends MutationEvent<Plugin> {
  static readonly eventName = PluginEvent.Installed;
  declare readonly before: null;
  declare readonly after: PluginInstalledSnapshot;
  readonly subject = ResourceType.Plugin;
  readonly subjectId: string;
  readonly provenance: PluginProvenance;
  readonly grantedPermissions: readonly GrantedPermissionRecord[];
  readonly auditFindings: readonly NpmAuditFinding[] | null;
  readonly staticAnalysis: readonly StaticAnalysisFinding[];
  readonly acknowledgedForbiddenImports: readonly string[];
  readonly retainedConfigReset: boolean;
  readonly actId: string;

  constructor(after: PluginInstalledSnapshot, context: PluginInstallAuditContext, initiatedAt: Date) {
    super(null, after, initiatedAt);
    this.subjectId = after.id;
    this.provenance = context.provenance;
    this.grantedPermissions = context.grantedPermissions;
    this.auditFindings = context.auditFindings;
    this.staticAnalysis = context.staticAnalysis;
    this.acknowledgedForbiddenImports = context.acknowledgedForbiddenImports;
    this.retainedConfigReset = context.retainedConfigReset ?? false;
    this.actId = context.actId;
  }
}

type PluginEnablementSnapshot = Readonly<Pick<Plugin, 'id' | 'slug' | 'enabled'>>;

export class PluginEnabledEvent extends MutationEvent<Plugin> {
  static readonly eventName = PluginEvent.Enabled;
  declare readonly before: PluginEnablementSnapshot;
  declare readonly after: PluginEnablementSnapshot;
  readonly subject = ResourceType.Plugin;
  readonly subjectId: string;

  constructor(before: PluginEnablementSnapshot, after: PluginEnablementSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

export class PluginDisabledEvent extends MutationEvent<Plugin> {
  static readonly eventName = PluginEvent.Disabled;
  declare readonly before: PluginEnablementSnapshot;
  declare readonly after: PluginEnablementSnapshot;
  readonly subject = ResourceType.Plugin;
  readonly subjectId: string;

  constructor(before: PluginEnablementSnapshot, after: PluginEnablementSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

type PluginUninstalledSnapshot = Readonly<Pick<Plugin, 'id' | 'slug' | 'version'>>;

export class PluginUninstalledEvent extends MutationEvent<Plugin> {
  static readonly eventName = PluginEvent.Uninstalled;
  declare readonly before: PluginUninstalledSnapshot;
  declare readonly after: null;
  readonly subject = ResourceType.Plugin;
  readonly subjectId: string;

  /**
   * Every household/user unit that had the plugin enabled at uninstall
   * time — context, not row state, captured before the purge because the
   * grant and (under `purgeData`) unit-config rows are gone by the time
   * anything consumes this. The seam the uninstall-announcement flow
   * (#324) renders "who is affected" from.
   */
  readonly affectedUnits: readonly PluginUnit[];

  constructor(before: PluginUninstalledSnapshot, affectedUnits: readonly PluginUnit[], initiatedAt: Date) {
    super(before, null, initiatedAt);
    this.subjectId = before.id;
    this.affectedUnits = affectedUnits;
  }
}

type PluginConfigSnapshot = Readonly<Pick<Plugin, 'id' | 'slug' | 'config'>>;

/** Server-scope plugin configuration changed (`Plugin.config`). Triggers the Phase B config pub/sub reload. */
export class PluginConfigUpdatedEvent extends MutationEvent<Plugin> {
  static readonly eventName = PluginEvent.ConfigUpdated;
  declare readonly before: PluginConfigSnapshot;
  declare readonly after: PluginConfigSnapshot;
  readonly subject = ResourceType.Plugin;
  readonly subjectId: string;

  constructor(before: PluginConfigSnapshot, after: PluginConfigSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/**
 * The consent act behind a unit event (#1150): the manifest version it was
 * decided against and the act's id, so the lifecycle row of every switch or
 * config write an act causes names the act. Null when no act caused
 * the change: a switch-off or a config write through the unit lifecycle.
 */
export interface PluginConsentActEventContext {
  readonly actId: string;
  readonly manifestVersion: string;
}

type HouseholdPluginConfigSnapshot = Readonly<Pick<HouseholdPlugin, 'id' | 'householdId' | 'pluginId' | 'config'>>;

/** Per-household plugin configuration changed (`HouseholdPlugin.config`). Same routing key as the server-scope event. */
export class HouseholdPluginConfigUpdatedEvent extends MutationEvent<HouseholdPlugin> {
  static readonly eventName = PluginEvent.ConfigUpdated;
  declare readonly before: HouseholdPluginConfigSnapshot;
  declare readonly after: HouseholdPluginConfigSnapshot;
  readonly subject = ResourceType.HouseholdPlugin;
  readonly subjectId: string;

  constructor(
    before: HouseholdPluginConfigSnapshot,
    after: HouseholdPluginConfigSnapshot,
    initiatedAt: Date,
    /** The consent act that made the change; null for one no act caused. */
    public readonly act: PluginConsentActEventContext | null = null,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

type HouseholdPluginSwitchSnapshot = Readonly<Pick<HouseholdPlugin, 'id' | 'householdId' | 'pluginId' | 'enabled'>>;

/**
 * The household admin flipped their unit's `enabled` switch ON — or first
 * enabled the plugin, creating the row (`before` is `null` exactly then;
 * #323). Shares the `plugin.enabled` routing key with the server-scope
 * class (the documented `ConfigUpdated` two-class precedent): listeners
 * discriminate on `instanceof` / `subject`, never on the key.
 */
export class HouseholdPluginEnabledEvent extends MutationEvent<HouseholdPlugin> {
  static readonly eventName = PluginEvent.Enabled;
  declare readonly before: HouseholdPluginSwitchSnapshot | null;
  declare readonly after: HouseholdPluginSwitchSnapshot;
  readonly subject = ResourceType.HouseholdPlugin;
  readonly subjectId: string;

  constructor(
    before: HouseholdPluginSwitchSnapshot | null,
    after: HouseholdPluginSwitchSnapshot,
    initiatedAt: Date,
    /** The consent act that made the change; null for one no act caused. */
    public readonly act: PluginConsentActEventContext | null = null,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/** The household admin flipped their unit's `enabled` switch OFF (#323) — see {@link HouseholdPluginEnabledEvent}. */
export class HouseholdPluginDisabledEvent extends MutationEvent<HouseholdPlugin> {
  static readonly eventName = PluginEvent.Disabled;
  declare readonly before: HouseholdPluginSwitchSnapshot;
  declare readonly after: HouseholdPluginSwitchSnapshot;
  readonly subject = ResourceType.HouseholdPlugin;
  readonly subjectId: string;

  constructor(
    before: HouseholdPluginSwitchSnapshot,
    after: HouseholdPluginSwitchSnapshot,
    initiatedAt: Date,
    /** The consent act that made the change; null for one no act caused. */
    public readonly act: PluginConsentActEventContext | null = null,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

type UserPluginSwitchSnapshot = Readonly<Pick<UserPlugin, 'id' | 'userId' | 'pluginId' | 'enabled'>>;

/**
 * The user flipped their own unit's `enabled` switch ON (#323), or switched
 * the plugin on for the first time with a consent act, creating the row
 * (`before` is `null` exactly then; #1150). Shares the `plugin.enabled`
 * routing key; `subject` disambiguates.
 */
export class UserPluginEnabledEvent extends MutationEvent<UserPlugin> {
  static readonly eventName = PluginEvent.Enabled;
  declare readonly before: UserPluginSwitchSnapshot | null;
  declare readonly after: UserPluginSwitchSnapshot;
  readonly subject = ResourceType.UserPlugin;
  readonly subjectId: string;

  constructor(
    before: UserPluginSwitchSnapshot | null,
    after: UserPluginSwitchSnapshot,
    initiatedAt: Date,
    /** The consent act that made the change; null for one no act caused. */
    public readonly act: PluginConsentActEventContext | null = null,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/** The user flipped their own unit's `enabled` switch OFF (#323) — see {@link UserPluginEnabledEvent}. */
export class UserPluginDisabledEvent extends MutationEvent<UserPlugin> {
  static readonly eventName = PluginEvent.Disabled;
  declare readonly before: UserPluginSwitchSnapshot;
  declare readonly after: UserPluginSwitchSnapshot;
  readonly subject = ResourceType.UserPlugin;
  readonly subjectId: string;

  constructor(
    before: UserPluginSwitchSnapshot,
    after: UserPluginSwitchSnapshot,
    initiatedAt: Date,
    /** The consent act that made the change; null for one no act caused. */
    public readonly act: PluginConsentActEventContext | null = null,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

type PluginUpdateCheckSnapshot = Readonly<
  Pick<Plugin, 'id' | 'slug' | 'lastUpdateCheckAt' | 'latestKnownVersion' | 'latestKnownChannel' | 'securityAdvisory'>
>;

/** An update-check poll completed and its result columns were persisted (#84 polling). */
export class PluginUpdateCheckCompletedEvent extends MutationEvent<Plugin> {
  static readonly eventName = PluginEvent.UpdateCheckCompleted;
  declare readonly before: PluginUpdateCheckSnapshot;
  declare readonly after: PluginUpdateCheckSnapshot;
  readonly subject = ResourceType.Plugin;
  readonly subjectId: string;

  constructor(
    before: PluginUpdateCheckSnapshot,
    after: PluginUpdateCheckSnapshot,
    /** True when the surfaced version is newer than the installed one under the effective channel floor. */
    public readonly updateAvailable: boolean,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/**
 * The staged-update events' row snapshot. `pendingStagingId` says which
 * staging the event concerns (#357): a rejected version can be staged again
 * from the same artifact, with the same version and checksum, and only the
 * staging id tells the two apart in the audit trail.
 */
type PluginUpdateStagingSnapshot = Readonly<
  Pick<Plugin, 'id' | 'slug' | 'version' | 'pendingVersion' | 'pendingStagingId'>
>;

/** A validated update was staged (`pendingVersion`/`pendingManifestJson` populated), awaiting consent (#59 update flow). */
export class PluginUpdatePendingEvent extends MutationEvent<Plugin> {
  static readonly eventName = PluginEvent.UpdatePending;
  declare readonly before: PluginUpdateStagingSnapshot;
  declare readonly after: PluginUpdateStagingSnapshot;
  readonly subject = ResourceType.Plugin;
  readonly subjectId: string;

  constructor(
    before: PluginUpdateStagingSnapshot,
    after: PluginUpdateStagingSnapshot,
    /**
     * Where the staged plugin artifact came from: its checksum, which every
     * staged update has (#696), and the link and registry an update approval
     * makes the plugin's own (#1096).
     */
    public readonly provenance: PluginProvenance,
    /** What escalated — WHY this update needed staged consent. Context for the lifecycle row and the C4 surface. */
    public readonly escalations: readonly UpdateEscalation[],
    /** Forbidden import specifiers the staging admin explicitly accepted on the NEW version. */
    public readonly acknowledgedForbiddenImports: readonly string[],
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

export class PluginUpdateApprovedEvent extends MutationEvent<Plugin> {
  static readonly eventName = PluginEvent.UpdateApproved;
  declare readonly before: PluginUpdateStagingSnapshot;
  declare readonly after: PluginUpdateStagingSnapshot;
  readonly subject = ResourceType.Plugin;
  readonly subjectId: string;

  constructor(
    before: PluginUpdateStagingSnapshot,
    after: PluginUpdateStagingSnapshot,
    /** The activated plugin artifact's provenance, which the plugin's row now names (#1096). */
    public readonly provenance: PluginProvenance,
    /**
     * Every server-scope permission this approval granted under its
     * `UpdateApprove` consent act (#1336), required ones that were already
     * granted included. Approval IS the consent act, so the record rides the
     * event the same way install's seed rides `plugin.installed`. A decision
     * the approval writes where none stood gets no per-grant event. One it
     * changes on an existing row, a denial overturned or a risk re-stamped,
     * also emits its grant event, which carries the row as it stood before.
     */
    public readonly grantedPermissions: readonly GrantedPermissionRecord[],
    /**
     * Activation found the retained server config invalid under the NEW
     * manifest's `config.schema` and reset it to `{}` (D-CN) — the same
     * "did my old settings survive" question `PluginInstalledEvent`
     * answers for a reinstall, ridden along here so activation is not the
     * one manifest-replacing path that leaves it unanswered.
     */
    public readonly retainedConfigReset: boolean,
    /**
     * The approval's `UpdateApprove` consent act (#1336), so the lifecycle row
     * names the act that holds what the server admin was shown. Null when an
     * update with nothing to consent to activated without approval: no act
     * was recorded.
     */
    public readonly actId: string | null,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

export class PluginUpdateRejectedEvent extends MutationEvent<Plugin> {
  static readonly eventName = PluginEvent.UpdateRejected;
  declare readonly before: PluginUpdateStagingSnapshot;
  declare readonly after: PluginUpdateStagingSnapshot;
  readonly subject = ResourceType.Plugin;
  readonly subjectId: string;

  constructor(before: PluginUpdateStagingSnapshot, after: PluginUpdateStagingSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

type PluginLoadFailureSnapshot = Readonly<Pick<Plugin, 'id' | 'slug' | 'loadFailed' | 'loadError'>>;

/** Boot-time load failure — plugin marked failed, server continues (#59 boot flow). */
export class PluginLoadFailedEvent extends MutationEvent<Plugin> {
  static readonly eventName = PluginEvent.LoadFailed;
  declare readonly before: PluginLoadFailureSnapshot;
  declare readonly after: PluginLoadFailureSnapshot;
  readonly subject = ResourceType.Plugin;
  readonly subjectId: string;

  constructor(before: PluginLoadFailureSnapshot, after: PluginLoadFailureSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

type PluginGrantSnapshot = Readonly<
  Pick<PluginGrant, 'id' | 'pluginId' | 'scopeType' | 'scopeId' | 'permissionSlug' | 'status' | 'decidedRiskLevel'>
>;

/**
 * What a grant event carries beyond the row (#1150): the consent decision row
 * no longer stores the manifest version, so the emitter states it, together
 * with the consent act that wrote the decision.
 */
export interface PluginGrantEventContext {
  /** The consent act that wrote the decision; every decision has one, the Server unit's included (#1336). */
  readonly actId: string;

  /** Version of the manifest the decision was made against. */
  readonly manifestVersion: string;
}

/**
 * A consent unit decided `Granted` — create-shaped on first decision,
 * update-shaped when a prior `Denied` row flips (#59 durable-denial model).
 */
export class PluginGrantCreatedEvent extends MutationEvent<PluginGrant> {
  static readonly eventName = PluginEvent.GrantCreated;
  declare readonly before: PluginGrantSnapshot | null;
  declare readonly after: PluginGrantSnapshot;
  readonly subject = ResourceType.PluginGrant;
  readonly subjectId: string;

  constructor(
    before: PluginGrantSnapshot | null,
    after: PluginGrantSnapshot,
    public readonly context: PluginGrantEventContext,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/** A consent unit decided `Denied` — the durable rejection record (#59/#60). */
export class PluginGrantRejectedEvent extends MutationEvent<PluginGrant> {
  static readonly eventName = PluginEvent.GrantRejected;
  declare readonly before: PluginGrantSnapshot | null;
  declare readonly after: PluginGrantSnapshot;
  readonly subject = ResourceType.PluginGrant;
  readonly subjectId: string;

  constructor(
    before: PluginGrantSnapshot | null,
    after: PluginGrantSnapshot,
    public readonly context: PluginGrantEventContext,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/**
 * Why a revocation fired. Carried on the event and persisted into the
 * lifecycle row payload — the consent decision itself is DELETED, so this is
 * the only durable record of why.
 *
 * One thing revokes a consent decision: rejecting the staged update it was
 * given to. Activating an update revokes none (#1152): a decision the active
 * manifest does not request at its scope is kept and confers nothing.
 * Uninstall's purge deletes every decision of the plugin, and announces the
 * uninstall rather than a revocation per decision. Losing authority revokes
 * nothing either: a consent decision belongs to the unit and survives the
 * person who made it (#1150).
 */
export type PluginGrantRevocationReason =
  /**
   * The staged update was rejected, so the pre-consents households and users
   * gave to it were deleted with it: a later update that requests the same
   * permission starts from no decision (#1150, #1152).
   */
  'staged-update-rejected';

/**
 * A consent decision was revoked: the row is deleted, returning the unit to
 * pending on that permission (#211) — delete-shaped, never a decision flip.
 * `reason` says why: a rejected staged update is the one thing that revokes
 * a consent decision (#1152). Distinct from `PluginGrantRejectedEvent`,
 * which records a decision somebody MADE.
 */
export class PluginGrantRevokedEvent extends MutationEvent<PluginGrant> {
  static readonly eventName = PluginEvent.GrantRevoked;
  declare readonly before: PluginGrantSnapshot;
  declare readonly after: null;
  readonly subject = ResourceType.PluginGrant;
  readonly subjectId: string;

  constructor(
    before: PluginGrantSnapshot,
    public readonly reason: PluginGrantRevocationReason,
    public readonly context: PluginGrantEventContext,
    initiatedAt: Date,
  ) {
    super(before, null, initiatedAt);
    this.subjectId = before.id;
  }
}

/**
 * Activating a plugin update announced that this household unit does not cover
 * the new manifest's re-consent slugs (#1149). Nothing on the unit enablement
 * changed and nothing was suspended: the household's consent standing is worked out
 * when read, so this event is the durable, notifiable record that a household
 * admin has a review pending, not a state transition. Hence `before` and
 * `after` are the same snapshot, as in {@link PluginUpdateCheckCompletedEvent}.
 *
 * Shares the `plugin.re_consent_requested` routing key with
 * {@link UserPluginReconsentRequestedEvent}; listeners discriminate on
 * `instanceof` / `subject`, never on the key.
 */
export class HouseholdPluginReconsentRequestedEvent extends MutationEvent<HouseholdPlugin> {
  static readonly eventName = PluginEvent.ReconsentRequested;
  declare readonly before: HouseholdPluginSwitchSnapshot;
  declare readonly after: HouseholdPluginSwitchSnapshot;
  readonly subject = ResourceType.HouseholdPlugin;
  readonly subjectId: string;

  constructor(
    unit: HouseholdPluginSwitchSnapshot,
    /** The re-consent slugs of the activated manifest that this unit does not yet cover. */
    public readonly outstandingPermissionSlugs: readonly string[],
    /** The manifest version whose activation announced the review. */
    public readonly manifestVersion: string,
    initiatedAt: Date,
  ) {
    super(unit, unit, initiatedAt);
    this.subjectId = unit.id;
  }
}

/**
 * The user-scope mirror of {@link HouseholdPluginReconsentRequestedEvent}
 * (#1149): an activation announced that this user's unit does not cover the
 * new manifest's re-consent slugs. The unit enablement is untouched.
 */
export class UserPluginReconsentRequestedEvent extends MutationEvent<UserPlugin> {
  static readonly eventName = PluginEvent.ReconsentRequested;
  declare readonly before: UserPluginSwitchSnapshot;
  declare readonly after: UserPluginSwitchSnapshot;
  readonly subject = ResourceType.UserPlugin;
  readonly subjectId: string;

  constructor(
    unit: UserPluginSwitchSnapshot,
    /** The re-consent slugs of the activated manifest that this unit does not yet cover. */
    public readonly outstandingPermissionSlugs: readonly string[],
    /** The manifest version whose activation announced the review. */
    public readonly manifestVersion: string,
    initiatedAt: Date,
  ) {
    super(unit, unit, initiatedAt);
    this.subjectId = unit.id;
  }
}
