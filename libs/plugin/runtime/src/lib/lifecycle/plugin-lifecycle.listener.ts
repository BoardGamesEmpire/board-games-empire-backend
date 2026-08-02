import { actorUserId, AuditContextService, MutationEvent, type SystemActor } from '@bge/actor-context';
import { DatabaseService, PluginGrantScope, type PluginLifecycleEventType, type Prisma } from '@bge/database';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginConfigEventsService } from '../config/plugin-config-events.service';
import { PLUGIN_EVENT_TO_LIFECYCLE_TYPE } from '../events/plugin-lifecycle-event-type.map';
import {
  HouseholdPluginConfigUpdatedEvent,
  HouseholdPluginUnitDisabledEvent,
  HouseholdPluginUnitEnabledEvent,
  PluginConfigUpdatedEvent,
  PluginGrantCreatedEvent,
  PluginGrantRejectedEvent,
  PluginGrantRevokedEvent,
  PluginInstalledEvent,
  PluginLoadFailedEvent,
  PluginUpdateApprovedEvent,
  PluginUpdateCheckCompletedEvent,
  PluginUpdatePendingEvent,
  UserPluginUnitDisabledEvent,
  UserPluginUnitEnabledEvent,
} from '../events/plugin.events';

/**
 * Fallback actor for a lifecycle emission with no populated CLS scope.
 * Same philosophy as the audit pipeline's unattributed fallback: the row is
 * a provenance label, never an authorization input, so an attribution gap
 * must produce a labeled row rather than a dropped one.
 */
export const UNATTRIBUTED_LIFECYCLE_ACTOR: SystemActor = {
  kind: 'system',
  reason: 'unattributed-lifecycle-emission',
};

/** Routing key → persisted enum, keyed for string lookup at dispatch time. */
const LIFECYCLE_TYPE_BY_ROUTING_KEY: ReadonlyMap<string, PluginLifecycleEventType> = new Map(
  Object.entries(PLUGIN_EVENT_TO_LIFECYCLE_TYPE),
);

interface LifecycleRowIdentity {
  readonly pluginId: string;
  /** `null` when the event class does not carry the slug — resolved via DB lookup. */
  readonly pluginSlug: string | null;
  readonly scopeType: PluginGrantScope | null;
  readonly scopeId: string | null;
  readonly manifestVersion: string | null;
  readonly payload: Record<string, unknown>;
}

/**
 * The Phase B provenance listener (#59): persists one
 * `plugin_lifecycle_events` row per plugin lifecycle `MutationEvent`,
 * POST-COMMIT — the write happens at handle time, after the mutating
 * transaction has committed and emitted, consistent with the audit
 * pipeline. The narrow crash window between commit and row insertion is
 * accepted: this table is provenance, not authorization state
 * (`PluginGrant` rows remain the source of truth for ability resolution).
 *
 * Registered via `onAny`, NOT `@OnEvent('plugin.**')` — the emitters run
 * `wildcard: false` (see `AuditPersistenceListener`), so a wildcard
 * decorator would never fire. `onAny` also hands us the routing key, which
 * is the dispatch input for the lifecycle-type map. Plugin-EMITTED domain
 * events (`plugin.<slug>.*`) share the prefix but are not lifecycle
 * routing keys and fail the map lookup; arbitrary payloads on lifecycle
 * keys fail the `instanceof MutationEvent` guard.
 *
 * This listener additionally publishes the config-reload pub/sub message
 * when a SERVER-scope config update lands — publish-on-mutation with a
 * single publish site, so Phase C's admin surface commits + emits and gets
 * cross-process reload for free. Household config updates do not publish:
 * server-scope snapshots are unaffected, and per-household config serving
 * is a per-request concern owned by the category context wrappers.
 *
 * The handler never throws into the emitter — a provenance failure must not
 * break the domain operation that produced the event.
 */
@Injectable()
export class PluginLifecycleListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PluginLifecycleListener.name);

  constructor(
    private readonly emitter: EventEmitter2,
    private readonly db: DatabaseService,
    private readonly auditContext: AuditContextService,
    private readonly configEvents: PluginConfigEventsService,
  ) {}

  onModuleInit(): void {
    this.emitter.onAny(this.anyListener);
  }

  onModuleDestroy(): void {
    this.emitter.offAny(this.anyListener);
  }

  // Arrow property so `this` is bound for on/offAny registration.
  private readonly anyListener = (event: string | string[], payload: unknown): void => {
    const name = Array.isArray(event) ? event.join('.') : event;
    void this.handle(name, payload);
  };

  private async handle(routingKey: string, payload: unknown): Promise<void> {
    const lifecycleType = LIFECYCLE_TYPE_BY_ROUTING_KEY.get(routingKey);

    if (lifecycleType === undefined || !(payload instanceof MutationEvent)) {
      return;
    }

    try {
      await this.persist(lifecycleType, payload);
    } catch (err) {
      this.logger.error(
        `Lifecycle persistence failed for "${routingKey}" (${payload.subject} ${payload.subjectId}): ${
          err instanceof Error ? err.message : err
        }`,
      );
    }

    // Deliberately OUTSIDE the persistence try: the reload is functional
    // state, provenance is a record — a failed provenance row must not leave
    // other processes on a stale snapshot for up to a full backstop interval.
    // `publish` handles its own failures and never throws.
    if (payload instanceof PluginConfigUpdatedEvent) {
      await this.configEvents.publish({ slug: payload.after.slug });
    }
  }

  private async persist(lifecycleType: PluginLifecycleEventType, event: MutationEvent): Promise<void> {
    const identity = this.buildIdentity(event);
    const actor = this.auditContext.getActor() ?? UNATTRIBUTED_LIFECYCLE_ACTOR;
    const pluginSlug = identity.pluginSlug ?? (await this.resolveSlug(identity.pluginId));

    await this.db.pluginLifecycleEvent.create({
      data: {
        pluginId: identity.pluginId,
        pluginSlug,
        event: lifecycleType,
        actor: this.serialize(actor),
        actorKind: actor.kind,
        actorUserId: actorUserId(actor),
        correlationId: this.auditContext.getCorrelationId(),
        manifestVersion: identity.manifestVersion,
        scopeType: identity.scopeType,
        scopeId: identity.scopeId,
        payload: this.serialize(identity.payload),
        occurredAt: event.occurredAt,
      },
    });
  }

  /**
   * Per-class identity + context extraction. The class hierarchy is the
   * dispatch mechanism (two classes share the `plugin.config_updated`
   * routing key, so `instanceof` — not the key — is authoritative). Context
   * fields deliberately kept OFF the before/after snapshots by the event
   * classes (provenance, grants, findings, error detail) are recovered here
   * into the row's `payload`.
   */
  private buildIdentity(event: MutationEvent): LifecycleRowIdentity {
    if (event instanceof PluginInstalledEvent) {
      return {
        pluginId: event.after.id,
        pluginSlug: event.after.slug,
        scopeType: null,
        scopeId: null,
        manifestVersion: event.after.version,
        payload: {
          provenance: event.provenance,
          grantedPermissions: event.grantedPermissions,
          auditFindings: event.auditFindings,
          staticAnalysis: event.staticAnalysis,
          // Whether an admin waved a forbidden import through, and which
          // ones, is a question asked of this table directly — not one to
          // reconstruct from which findings can coexist with an install.
          acknowledgedForbiddenImports: event.acknowledgedForbiddenImports,
        },
      };
    }

    if (event instanceof HouseholdPluginConfigUpdatedEvent) {
      return {
        pluginId: event.after.pluginId,
        pluginSlug: null,
        scopeType: PluginGrantScope.Household,
        scopeId: event.after.householdId,
        manifestVersion: null,
        payload: {},
      };
    }

    if (event instanceof HouseholdPluginUnitDisabledEvent) {
      return {
        pluginId: event.after.pluginId,
        pluginSlug: null,
        scopeType: PluginGrantScope.Household,
        scopeId: event.after.householdId,
        manifestVersion: event.manifestVersion,
        // The escalating slugs are the durable "why" for this suspension —
        // the notification listener and the #67 timeline read them from
        // here, never from a mutable column (D-AO).
        payload: { requiredPermissionSlugs: event.requiredPermissionSlugs },
      };
    }

    if (event instanceof HouseholdPluginUnitEnabledEvent) {
      return {
        pluginId: event.after.pluginId,
        pluginSlug: null,
        scopeType: PluginGrantScope.Household,
        scopeId: event.after.householdId,
        manifestVersion: event.manifestVersion,
        payload: { grantedPermissionSlug: event.grantedPermissionSlug },
      };
    }

    // User-unit suspension events (#225) share the UnitDisabled/UnitEnabled
    // routing keys with the household classes; the class IS the scope.
    if (event instanceof UserPluginUnitDisabledEvent) {
      return {
        pluginId: event.after.pluginId,
        pluginSlug: null,
        scopeType: PluginGrantScope.User,
        scopeId: event.after.userId,
        manifestVersion: event.manifestVersion,
        payload: { requiredPermissionSlugs: event.requiredPermissionSlugs },
      };
    }

    if (event instanceof UserPluginUnitEnabledEvent) {
      return {
        pluginId: event.after.pluginId,
        pluginSlug: null,
        scopeType: PluginGrantScope.User,
        scopeId: event.after.userId,
        manifestVersion: event.manifestVersion,
        payload: { grantedPermissionSlug: event.grantedPermissionSlug },
      };
    }

    if (event instanceof PluginGrantRevokedEvent) {
      return {
        pluginId: event.before.pluginId,
        pluginSlug: null,
        scopeType: event.before.scopeType,
        scopeId: event.before.scopeId === '' ? null : event.before.scopeId,
        manifestVersion: event.before.manifestVersion,
        // The grant row is gone (delete-to-pending, #211): the lifecycle row
        // is the only durable record of what was revoked and why.
        payload: {
          permissionSlug: event.before.permissionSlug,
          decidedRiskLevel: event.before.decidedRiskLevel,
          reason: event.reason,
        },
      };
    }

    if (event instanceof PluginGrantCreatedEvent || event instanceof PluginGrantRejectedEvent) {
      return {
        pluginId: event.after.pluginId,
        pluginSlug: null,
        scopeType: event.after.scopeType,
        // The grant row's Server-scope EMPTY-STRING SENTINEL exists for
        // uniqueness enforcement there; no uniqueness rides this table, so
        // the readable form is null.
        scopeId: event.after.scopeId === '' ? null : event.after.scopeId,
        manifestVersion: event.after.manifestVersion,
        // decidedRiskLevel rides every grant lifecycle row, not just revocations:
        // the risk a unit consented under is the comparison input for update-time
        // escalation, and reconstructing it later from the seed catalog would read
        // TODAY's classification rather than the one shown at decision time.
        payload: {
          permissionSlug: event.after.permissionSlug,
          status: event.after.status,
          decidedRiskLevel: event.after.decidedRiskLevel,
        },
      };
    }

    if (event instanceof PluginLoadFailedEvent) {
      return {
        ...this.pluginRowIdentity(event.after),
        payload: { loadError: event.after.loadError },
      };
    }

    if (event instanceof PluginUpdateCheckCompletedEvent) {
      return {
        ...this.pluginRowIdentity(event.after),
        payload: { updateAvailable: event.updateAvailable },
      };
    }

    if (event instanceof PluginUpdatePendingEvent) {
      return {
        ...this.pluginRowIdentity(event.after),
        payload: {
          pendingVersion: event.after.pendingVersion,
          pendingSha256: event.pendingSha256,
          // What escalated and what the staging admin waved through — the
          // consent record for WHY approval was demanded (D-AP/D-AJ).
          escalations: event.escalations,
          acknowledgedForbiddenImports: event.acknowledgedForbiddenImports,
        },
      };
    }

    if (event instanceof PluginUpdateApprovedEvent) {
      return {
        ...this.pluginRowIdentity(event.after),
        // Approval is the consent act for the update's new server checks;
        // per-grant events are deliberately not emitted (install parity),
        // so this payload is where the seed's provenance lives.
        payload: { grantedPermissions: event.grantedPermissions },
      };
    }

    // Remaining Plugin-subject events (Enabled, Disabled, Uninstalled,
    // ConfigUpdated, UpdateRejected): id + slug live on
    // whichever snapshot is non-null; no extra context payload.
    const snapshot = (event.after ?? event.before) as { id?: unknown; slug?: unknown };

    return this.pluginRowIdentity({
      id: typeof snapshot.id === 'string' ? snapshot.id : event.subjectId,
      slug: typeof snapshot.slug === 'string' ? snapshot.slug : null,
    });
  }

  private pluginRowIdentity(snapshot: { readonly id: string; readonly slug: string | null }): LifecycleRowIdentity {
    return {
      pluginId: snapshot.id,
      pluginSlug: snapshot.slug,
      scopeType: null,
      scopeId: null,
      manifestVersion: null,
      payload: {},
    };
  }

  /**
   * Grant/household events carry `pluginId` but not the slug; the table
   * denormalizes the slug so timelines stay readable after uninstall. A
   * missing row (uninstall race) records the labeled placeholder rather
   * than failing provenance.
   */
  private async resolveSlug(pluginId: string): Promise<string> {
    const row = await this.db.plugin.findUnique({ where: { id: pluginId }, select: { slug: true } });

    if (row === null) {
      this.logger.warn(`Plugin ${pluginId} not found while resolving slug for lifecycle row — recording placeholder`);
      return 'unknown';
    }

    return row.slug;
  }

  /**
   * JSON round-trip rather than a bare cast: guarantees the value is
   * serializable (Dates → ISO strings, undefined dropped) so the Prisma
   * write cannot fail on a non-JSON payload smuggled through `unknown`.
   */
  private serialize(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
