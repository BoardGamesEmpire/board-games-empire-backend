import { MutationEvent } from '@bge/actor-context';
import type { HouseholdPlugin, Plugin, PluginGrant } from '@bge/database';
import { ResourceType } from '@bge/database';
import type { PluginConsentScopeValue } from '@boardgamesempire/plugin-manifest';
import { PluginEvent } from './constants.js';

/**
 * Plugin lifecycle events (#59, decision D-A as refined during Phase A).
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

export class PluginInstalledEvent extends MutationEvent<Plugin> {
  static readonly eventName = PluginEvent.Installed;

  declare readonly before: null;
  declare readonly after: PluginInstalledSnapshot;

  readonly subject = ResourceType.Plugin;
  readonly subjectId: string;

  constructor(
    after: PluginInstalledSnapshot,
    /** Ingress provenance — context for the lifecycle table, not row state. */
    public readonly provenance: PluginProvenance,
    /** Server-consentable permissions granted by the installing admin (#59 install step 13). */
    public readonly grantedPermissions: readonly GrantedPermissionRecord[],
    /** npm advisory findings acknowledged at install, `null` when no lockfile was present (#84). */
    public readonly auditFindings: readonly NpmAuditFinding[] | null,
    initiatedAt: Date,
  ) {
    super(null, after, initiatedAt);
    this.subjectId = after.id;
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

  constructor(before: PluginUninstalledSnapshot, initiatedAt: Date) {
    super(before, null, initiatedAt);
    this.subjectId = before.id;
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

  constructor(before: PluginUpdateStagingSnapshot, after: PluginUpdateStagingSnapshot, initiatedAt: Date) {
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
  Pick<PluginGrant, 'id' | 'pluginId' | 'scopeType' | 'scopeId' | 'permissionSlug' | 'status' | 'manifestVersion'>
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

type HouseholdPluginEnablementSnapshot = Readonly<Pick<HouseholdPlugin, 'id' | 'householdId' | 'pluginId' | 'enabled'>>;

/**
 * A consent unit was auto-disabled because an update promoted a permission
 * to required at its consent scope and the unit has not accepted (#59
 * consent-unit escalation semantics).
 */
export class HouseholdPluginUnitDisabledEvent extends MutationEvent<HouseholdPlugin> {
  static readonly eventName = PluginEvent.UnitDisabled;

  declare readonly before: HouseholdPluginEnablementSnapshot;
  declare readonly after: HouseholdPluginEnablementSnapshot;

  readonly subject = ResourceType.HouseholdPlugin;
  readonly subjectId: string;

  constructor(
    before: HouseholdPluginEnablementSnapshot,
    after: HouseholdPluginEnablementSnapshot,
    /** The escalated permission that forced the disable — context for the notification listener. */
    public readonly requiredPermissionSlug: string,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}
