import { MutationEvent, type PluginUnit } from '@bge/actor-context';
import type { HouseholdPlugin, Plugin, PluginGrant, UserPlugin } from '@bge/database';
import { ResourceType } from '@bge/database';
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

/** Where an installed artifact came from (#84 ingress). All-null for `bundled` plugins. */
export interface PluginProvenance {
  readonly installedFromUrl: string | null;
  readonly installedSha256: string | null;
  readonly registrySlug: string | null;
}

/** One consent decision captured at install time — `reason` is resolved to the server default locale. */
export interface GrantedPermissionRecord {
  readonly slug: string;
  readonly required: boolean;
  readonly consentScope: PluginConsentScopeValue;
  readonly reason: string;
}

/**
 * Minimal npm-advisory finding recorded alongside an install (#84 step 5).
 * Shape intentionally small; #84 owns the full report and may extend this.
 */
export interface NpmAuditFinding {
  readonly module: string;
  readonly severity: 'low' | 'moderate' | 'high' | 'critical';
  readonly advisoryUrl: string;
}

type PluginInstalledSnapshot = Readonly<
  Pick<Plugin, 'id' | 'slug' | 'version' | 'category' | 'scope' | 'enabled' | 'bundled'>
>;

/**
 * The install-specific context an installed event carries beyond the row
 * snapshot. A single object rather than a growing positional tail: the
 * pipeline has already added static-analysis findings and the override
 * record, and #84's npm audit step extends this shape too — each of those
 * would otherwise be another argument nobody can read at the call site.
 * Reads stay flat (`event.provenance`), so consumers are unaffected.
 */
export interface PluginInstallAuditContext {
  /** Ingress provenance — context for the lifecycle table, not row state. */
  readonly provenance: PluginProvenance;
  /** Server-consentable permissions granted by the installing admin. */
  readonly grantedPermissions: readonly GrantedPermissionRecord[];
  /** npm advisory findings acknowledged at install, `null` when no lockfile was present (#84). */
  readonly auditFindings: readonly NpmAuditFinding[] | null;
  /** Everything static analysis reported: warnings, deep-scan advisories, and any overridden forbidden imports. */
  readonly staticAnalysis: readonly StaticAnalysisFinding[];
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
   * A reinstall over a tombstone found the retained server config invalid
   * under the NEW manifest's `config.schema` and reset it to `{}` —
   * "did my old settings survive the reinstall" is answered here, not
   * reconstructed from row state. Always false on a fresh install; optional
   * so pre-reinstall construction sites need no churn.
   */
  readonly retainedConfigReset?: boolean;
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

  constructor(after: PluginInstalledSnapshot, context: PluginInstallAuditContext, initiatedAt: Date) {
    super(null, after, initiatedAt);
    this.subjectId = after.id;
    this.provenance = context.provenance;
    this.grantedPermissions = context.grantedPermissions;
    this.auditFindings = context.auditFindings;
    this.staticAnalysis = context.staticAnalysis;
    this.acknowledgedForbiddenImports = context.acknowledgedForbiddenImports;
    this.retainedConfigReset = context.retainedConfigReset ?? false;
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

type PluginUninstalledSnapshot = Readonly<Pick<Plugin, 'id' | 'slug' | 'version' | 'bundled'>>;

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

type HouseholdPluginConfigSnapshot = Readonly<Pick<HouseholdPlugin, 'id' | 'householdId' | 'pluginId' | 'config'>>;

/** Per-household plugin configuration changed (`HouseholdPlugin.config`). Same routing key as the server-scope event. */
export class HouseholdPluginConfigUpdatedEvent extends MutationEvent<HouseholdPlugin> {
  static readonly eventName = PluginEvent.ConfigUpdated;

  declare readonly before: HouseholdPluginConfigSnapshot;
  declare readonly after: HouseholdPluginConfigSnapshot;

  readonly subject = ResourceType.HouseholdPlugin;
  readonly subjectId: string;

  constructor(before: HouseholdPluginConfigSnapshot, after: HouseholdPluginConfigSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

type HouseholdPluginSwitchSnapshot = Readonly<
  Pick<HouseholdPlugin, 'id' | 'householdId' | 'pluginId' | 'enabled' | 'suspendedForConsent'>
>;

/**
 * The household admin flipped their unit's `enabled` switch ON — or first
 * enabled the plugin, creating the row (`before` is `null` exactly then;
 * #323). Shares the `plugin.enabled` routing key with the server-scope
 * class (the documented `ConfigUpdated` two-class precedent): listeners
 * discriminate on `instanceof` / `subject`, never on the key. Deliberately
 * NOT `UnitEnabled` — that key means a consent suspension lifted, and
 * listeners for consent transitions must not have to filter admin
 * kill-switch flips.
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
    /**
     * Required household-scope permissions whose durable denial made the
     * row be CREATED suspended — non-empty only on a born-suspended
     * creation. Context for the lifecycle row, not row state: no
     * consent-machinery suspension event fires for a birth state (nothing
     * transitioned), so without this the durable record of WHY the unit
     * started suspended would not exist — every other suspension leaves
     * one.
     */
    public readonly bornSuspendedSlugs: readonly string[] = [],
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

  constructor(before: HouseholdPluginSwitchSnapshot, after: HouseholdPluginSwitchSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

type UserPluginSwitchSnapshot = Readonly<
  Pick<UserPlugin, 'id' | 'userId' | 'pluginId' | 'enabled' | 'suspendedForConsent'>
>;

/**
 * The user flipped their own unit's `enabled` switch ON (#323). Never
 * creation-shaped: `decide()` remains the only creator of `UserPlugin`
 * rows (#225), so this event always carries a real `before`. Shares the
 * `plugin.enabled` routing key; `subject` disambiguates.
 */
export class UserPluginEnabledEvent extends MutationEvent<UserPlugin> {
  static readonly eventName = PluginEvent.Enabled;

  declare readonly before: UserPluginSwitchSnapshot;
  declare readonly after: UserPluginSwitchSnapshot;

  readonly subject = ResourceType.UserPlugin;
  readonly subjectId: string;

  constructor(before: UserPluginSwitchSnapshot, after: UserPluginSwitchSnapshot, initiatedAt: Date) {
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

  constructor(before: UserPluginSwitchSnapshot, after: UserPluginSwitchSnapshot, initiatedAt: Date) {
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

type PluginUpdateStagingSnapshot = Readonly<Pick<Plugin, 'id' | 'slug' | 'version' | 'pendingVersion'>>;

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
    /** Checksum of the staged tarball; `null` for bundled upgrades. */
    public readonly pendingSha256: string | null,
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
    /**
     * Server-consentable permissions this approval granted — the update's
     * NEW checks, seeded on activation. Approval IS the consent act, so the
     * record rides the event the same way install's seed rides
     * `plugin.installed`; per-grant events are deliberately not emitted.
     */
    public readonly grantedPermissions: readonly GrantedPermissionRecord[],
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
  Pick<
    PluginGrant,
    'id' | 'pluginId' | 'scopeType' | 'scopeId' | 'permissionSlug' | 'status' | 'manifestVersion' | 'decidedRiskLevel'
  >
>;

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

  constructor(before: PluginGrantSnapshot | null, after: PluginGrantSnapshot, initiatedAt: Date) {
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

  constructor(before: PluginGrantSnapshot | null, after: PluginGrantSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/**
 * Why an authority-loss revocation fired (#211). Carried on the event
 * and persisted into the lifecycle row payload — the grant row itself is
 * DELETED (delete-to-pending), so this is the only durable record of why.
 */
export type PluginGrantRevocationReason =
  | 'membership-removed'
  | 'role-demoted'
  | 'user-deleted'
  | 'household-deleted'
  /** The declaring plugin's update removed the permission from `declares[]` — the catalog diff deleted its grants. */
  | 'permission-removed'
  /**
   * An update moved the permission to a different consent scope, so the
   * decision recorded at the OLD scope no longer authorizes anything — the
   * principal that made it does not own the permission any more.
   */
  | 'consent-scope-changed';

/**
 * A grant was revoked because the authority that justified it lapsed
 * (#211 eager revoke): the row is deleted, returning the unit to pending —
 * delete-shaped, never a decision flip. Distinct from
 * `PluginGrantRejectedEvent`, which records a decision somebody MADE.
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
    initiatedAt: Date,
  ) {
    super(before, null, initiatedAt);
    this.subjectId = before.id;
  }
}

type HouseholdPluginSuspensionSnapshot = Readonly<
  Pick<HouseholdPlugin, 'id' | 'householdId' | 'pluginId' | 'enabled' | 'suspendedForConsent'>
>;

/**
 * A consent unit was SUSPENDED because an update escalated a permission to
 * required at its consent scope and the unit has not accepted (#59
 * consent-unit escalation semantics). Suspension is explicit state
 * (`suspendedForConsent`), never an `enabled` flip — the admin's prior
 * intent survives, and late acceptance restores exactly it.
 * The escalating slugs and manifest version ride the event: the lifecycle
 * row is the durable "why".
 */
export class HouseholdPluginUnitDisabledEvent extends MutationEvent<HouseholdPlugin> {
  static readonly eventName = PluginEvent.UnitDisabled;

  declare readonly before: HouseholdPluginSuspensionSnapshot;
  declare readonly after: HouseholdPluginSuspensionSnapshot;

  readonly subject = ResourceType.HouseholdPlugin;
  readonly subjectId: string;

  constructor(
    before: HouseholdPluginSuspensionSnapshot,
    after: HouseholdPluginSuspensionSnapshot,
    /** Every escalated required-at-scope permission the unit has not accepted — one suspension, however many slugs forced it. */
    public readonly requiredPermissionSlugs: readonly string[],
    /** The manifest version whose escalation suspended the unit. */
    public readonly manifestVersion: string,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/**
 * Late acceptance re-enabled a suspended unit: a `Granted` decision
 * cleared the last outstanding required-at-scope permission, so
 * `PluginGrantService.decide()` lifted the suspension in the same flow —
 * the consent act is the re-enable trigger by definition. Own routing key,
 * symmetric with `UnitDisabled`: listeners for consent-suspension
 * transitions must not have to filter server kill-switch flips.
 */
export class HouseholdPluginUnitEnabledEvent extends MutationEvent<HouseholdPlugin> {
  static readonly eventName = PluginEvent.UnitEnabled;

  declare readonly before: HouseholdPluginSuspensionSnapshot;
  declare readonly after: HouseholdPluginSuspensionSnapshot;

  readonly subject = ResourceType.HouseholdPlugin;
  readonly subjectId: string;

  constructor(
    before: HouseholdPluginSuspensionSnapshot,
    after: HouseholdPluginSuspensionSnapshot,
    /** The decision that cleared the last outstanding requirement. */
    public readonly grantedPermissionSlug: string,
    /** The active manifest version whose requirements are now fully consented. */
    public readonly manifestVersion: string,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

type UserPluginSuspensionSnapshot = Readonly<
  Pick<UserPlugin, 'id' | 'userId' | 'pluginId' | 'enabled' | 'suspendedForConsent'>
>;

/**
 * A USER consent unit was suspended pending re-consent (#225) — the exact
 * user-scope mirror of `HouseholdPluginUnitDisabledEvent`. Shares the
 * `plugin.unit_disabled` routing key (the documented `ConfigUpdated`
 * two-class precedent): listeners discriminate on `instanceof` / `subject`,
 * never on the key. Suspension is explicit state (`suspendedForConsent`),
 * exactly as at household scope: the user's `enabled` intent survives, and
 * late acceptance restores exactly it.
 */
export class UserPluginUnitDisabledEvent extends MutationEvent<UserPlugin> {
  static readonly eventName = PluginEvent.UnitDisabled;

  declare readonly before: UserPluginSuspensionSnapshot;
  declare readonly after: UserPluginSuspensionSnapshot;

  readonly subject = ResourceType.UserPlugin;
  readonly subjectId: string;

  constructor(
    before: UserPluginSuspensionSnapshot,
    after: UserPluginSuspensionSnapshot,
    /** Every escalated re-consent permission the user has not accepted — one suspension, however many slugs forced it. */
    public readonly requiredPermissionSlugs: readonly string[],
    /** The manifest version whose escalation suspended the unit. */
    public readonly manifestVersion: string,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/**
 * Late acceptance re-enabled a suspended USER unit (#225): a `Granted`
 * decision cleared the last outstanding user-scope
 * requirement, so `PluginGrantService.decide()` lifted the suspension in
 * the same flow. Shares the `plugin.unit_enabled` routing key with the
 * household class; `subject` disambiguates.
 */
export class UserPluginUnitEnabledEvent extends MutationEvent<UserPlugin> {
  static readonly eventName = PluginEvent.UnitEnabled;

  declare readonly before: UserPluginSuspensionSnapshot;
  declare readonly after: UserPluginSuspensionSnapshot;

  readonly subject = ResourceType.UserPlugin;
  readonly subjectId: string;

  constructor(
    before: UserPluginSuspensionSnapshot,
    after: UserPluginSuspensionSnapshot,
    /** The decision that cleared the last outstanding requirement. */
    public readonly grantedPermissionSlug: string,
    /** The active manifest version whose requirements are now fully consented. */
    public readonly manifestVersion: string,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}
