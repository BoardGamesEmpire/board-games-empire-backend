import type { PluginUnit } from '@bge/actor-context';
import {
  DatabaseService,
  grantScopeCoordinatesForUnit,
  hasBoundingConditions,
  loadPluginUnitEnablement,
  PluginGrantScope,
  PluginGrantStatus,
  type RiskLevel,
  riskCovers,
} from '@bge/database';
import { isPluginPermissionSlug, parsePluginPermissionSlug } from '@boardgamesempire/plugin-manifest';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { PluginAbilityRenderRejectionError } from './errors/plugin-ability-render-rejection.error';
import type { ApikeyWithScopes, PluginGrantSnapshot, UserWithRoles } from './interfaces';

@Injectable()
export class PermissionsService {
  private readonly logger = new Logger(PermissionsService.name);

  static readonly CACHE_TTL_IN_MILLISECONDS = 5 * 60 * 1000;

  /**
   * Floor for the user-graph cache TTL. The build-time `expiresAt` re-check in
   * `AbilityFactory` is the correctness guarantee for expiry; this clamp is only
   * an optimization to refresh sooner, so it never needs to drop below this floor
   * (which also avoids cache stampede when a permission is about to expire).
   */
  static readonly MIN_CACHE_TTL_IN_MILLISECONDS = 5 * 1000;

  /**
   * Max concurrent cache evictions per batch in {@link invalidateUsers}. Bounds
   * the burst of cache calls when a mutation touches many users at once.
   */
  static readonly EVICTION_BATCH_SIZE = 50;

  constructor(
    private readonly db: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /**
   * Cache key for a user's resolved permission graph. Single source of truth for
   * the key format — both the writer ({@link getUserRoleGraph}) and every
   * invalidation path go through here so the two can never drift.
   */
  static userGraphCacheKey(userId: string): string {
    return `bge:user:permissions:${userId}`;
  }

  async getUserRoleGraph(userId: string): Promise<UserWithRoles | null> {
    const userGraph = await this.getOrLoad(
      PermissionsService.userGraphCacheKey(userId),
      `user role graph for user ${userId}`,
      () => this.loadUserGraph(userId),
      (graph) => this.cacheTtlForGraph(graph),
    );

    return userGraph as UserWithRoles | null;
  }

  /**
   * Evict one user's cached permission graph so their abilities are rebuilt from
   * the DB on next resolution. MUST be called after any change to a user's
   * grants — role assignment, household/event membership add/remove/role-change,
   * invite acceptance — otherwise stale abilities persist up to the cache TTL
   * ({@link CACHE_TTL_IN_MILLISECONDS}). The per-membership build in
   * `AbilityFactory` means a membership change invalidates only the affected
   * user, not the whole household.
   */
  async invalidateUser(userId: string | null | undefined): Promise<void> {
    // Tolerate a nullish id (some entities carry a nullable created/updatedById):
    // there is nothing to evict, so no-op rather than delete a garbage key.
    if (!userId) {
      return;
    }

    // Per-user success/failure is logged inside evictUserGraph (which swallows
    // failures), so nothing is logged here — a summary would overstate success.
    await this.evictUserGraph(userId);
  }

  /**
   * Bulk counterpart to {@link invalidateUser} for mutations that change several
   * users' grants at once (e.g. ownership transfer touches both parties, a
   * household delete touches every member). De-dupes ids, drops nullish ids, and
   * no-ops on an empty set.
   *
   * Evicts in fixed-size batches ({@link EVICTION_BATCH_SIZE}) to bound
   * concurrency: a large user set (e.g. a bulk role change) can't burst hundreds
   * of concurrent cache calls. {@link evictUserGraph} swallows per-user failures,
   * so no batch rejects and one bad eviction can't abandon the rest.
   */
  async invalidateUsers(userIds: readonly (string | null | undefined)[]): Promise<void> {
    const unique = [...new Set(userIds)].filter((userId): userId is string => Boolean(userId));
    if (unique.length === 0) {
      return;
    }

    for (let i = 0; i < unique.length; i += PermissionsService.EVICTION_BATCH_SIZE) {
      const batch = unique.slice(i, i + PermissionsService.EVICTION_BATCH_SIZE);
      await Promise.all(batch.map((userId) => this.evictUserGraph(userId)));
    }

    this.logger.debug(`Requested permission-graph invalidation for ${unique.length} user(s)`);
  }

  /**
   * Best-effort eviction of a single user graph. A cache failure is logged and
   * swallowed rather than thrown: the build-time `expiresAt` re-check and the
   * graph TTL are the correctness backstop, so a transient cache outage degrades
   * to "stale until TTL" instead of turning into an unhandled rejection that
   * leaves the already-committed mutation reported as a failure. The debug line
   * is logged only when the `del` call resolves without error — the cache API
   * doesn't report whether a key was present, so it reflects a completed
   * invalidation (the graph is now absent), not a confirmed prior cache hit.
   */
  private async evictUserGraph(userId: string): Promise<void> {
    try {
      await this.cache.del(PermissionsService.userGraphCacheKey(userId));
      this.logger.debug(`Invalidated permission graph for user ${userId}`);
    } catch (error) {
      this.logger.error(`Failed to invalidate permission graph for user ${userId}`, error);
    }
  }

  /**
   * Loads an API key with its scopes and each scope's permission triple
   * (action/subject/inverted) — the shape `AbilityFactory.createForApiKey`
   * consumes. The actor only carries the key id, so the scope graph must be
   * resolved here.
   *
   * Returns `null` when the key no longer exists (e.g. revoked between auth and
   * ability resolution); the caller fails loud rather than building a
   * permissive ability from a missing key.
   */
  async getApiKeyScopeGraph(apiKeyId: string): Promise<ApikeyWithScopes | null> {
    const apiKey = await this.getOrLoad(
      `bge:apikey:scopes:${apiKeyId}`,
      `API key scope graph for key ${apiKeyId}`,
      () => this.loadApiKeyGraph(apiKeyId),
    );

    return apiKey as ApikeyWithScopes | null;
  }

  /**
   * Cache-aside loader shared by the permission graphs: serve a cache hit,
   * otherwise run `loader` and cache only a non-null result. A missing row is
   * never negatively cached and surfaces as `null` for the caller to handle.
   *
   * `ttlFor` lets a caller derive a per-entry TTL from the loaded value (used to
   * clamp the user graph to a soon-to-expire permission); it defaults to the
   * static TTL.
   */
  private async getOrLoad<T extends object>(
    cacheKey: string,
    label: string,
    loader: () => Promise<T | null>,
    ttlFor: (value: T) => number = () => PermissionsService.CACHE_TTL_IN_MILLISECONDS,
  ): Promise<T | null> {
    const cached = await this.cache.get<T>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for ${label}`);
      return cached;
    }

    const fresh = await loader();
    if (!fresh) {
      this.logger.warn(`Not found while loading ${label}`);
      return null;
    }

    const ttl = ttlFor(fresh);
    this.logger.debug(`Loaded ${label} from database, caching result (ttl=${ttl}ms)`);
    await this.cache.set(cacheKey, fresh, ttl);

    return fresh;
  }

  /**
   * Clamps the cache TTL to the soonest non-expired `UserPermission.expiresAt`
   * so an expiring grant/denial is re-evaluated promptly, floored at
   * {@link MIN_CACHE_TTL_IN_MILLISECONDS} and capped at the default TTL. Rows
   * that expire sub-floor are still handled correctly by the build-time check in
   * `AbilityFactory`.
   */
  private cacheTtlForGraph(graph: { permissions?: { expiresAt: Date | null }[] }): number {
    const { CACHE_TTL_IN_MILLISECONDS, MIN_CACHE_TTL_IN_MILLISECONDS } = PermissionsService;
    const now = Date.now();

    const upcoming = (graph.permissions ?? [])
      .map((permission) => permission.expiresAt?.getTime())
      .filter((time): time is number => typeof time === 'number' && time > now)
      .map((time) => time - now);

    if (upcoming.length === 0) {
      return CACHE_TTL_IN_MILLISECONDS;
    }

    return Math.max(MIN_CACHE_TTL_IN_MILLISECONDS, Math.min(CACHE_TTL_IN_MILLISECONDS, Math.min(...upcoming)));
  }

  private loadUserGraph(userId: string) {
    return this.db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        roles: {
          select: {
            role: {
              select: {
                name: true,
                permissions: {
                  select: {
                    permission: true,
                  },
                },
              },
            },
          },
        },

        householdMember: {
          // A soft-deleted household must not contribute household-scoped grants:
          // the row survives the (soft) delete, so exclude memberships whose
          // household is gone or abilities would linger past a cache refresh.
          where: { household: { deletedAt: null } },
          select: {
            householdId: true,
            role: {
              select: {
                role: {
                  select: {
                    name: true,
                    permissions: {
                      select: {
                        permission: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },

        eventsAttended: {
          select: {
            eventId: true,
            role: {
              select: {
                role: {
                  select: {
                    name: true,
                    permissions: {
                      select: {
                        permission: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },

        // Direct per-user overrides (grants + inverse denials). Already-expired
        // rows are excluded at query time; the factory re-checks `expiresAt` at
        // build time as the backstop.
        permissions: {
          where: {
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          select: {
            inverted: true,
            resourceType: true,
            resourceId: true,
            expiresAt: true,
            permission: {
              select: {
                action: true,
                subject: true,
                conditions: true,
                fields: true,
                inverted: true,
              },
            },
          },
        },
      },
    });
  }

  /**
   * Resolves the granted-permission snapshot a plugin ability is built from
   * (#60): `Granted` rows for the operating unit's coordinates plus
   * the always-applicable Server scope, with both consumption guards applied
   * here rather than trusted to upstream machinery —
   *
   * - **Serving predicate.** `servable` is false when the plugin is disabled
   *   or tombstoned, or (Household/User units) when the unit's enablement
   *   row is missing, disabled, or `suspendedForConsent`. Suspension and
   *   gated approval make a plain intersection transitively safe only while
   *   every invoker remembers to check; applying it where grants are
   *   consumed documents the invariant at the point of consumption.
   * - **Risk coverage.** A grant whose `decidedRiskLevel` no longer covers
   *   the permission's current catalog risk confers nothing (C3's "a
   *   Granted row is not consent" — the stale risk is exactly what
   *   escalated). Grants over slugs with no surviving catalog row likewise
   *   confer nothing; both exclusions are logged at debug, not silently
   *   swallowed.
   * - **Unit-bounded conferral.** A Household/User-scope grant confers a
   *   core permission only when the row carries bounding conditions
   *   (`hasBoundingConditions`): a condition-free row is subject-wide
   *   authority that only SERVER consent can confer. Warned, not debug —
   *   the install/update gates and `decide()` refuse to create such
   *   grants, so one existing can only mean the catalog drifted under a
   *   recorded decision.
   *
   * Returns `null` when no `Plugin` row exists for the id — the caller
   * decides what a dangling plugin actor means. Deliberately uncached: a
   * consent decision must take effect on the next resolution, and no
   * invalidation path exists yet (mirrors the feature-state service's "no
   * caching until measured" posture).
   *
   * Related but deliberately NOT the same predicate as the runtime's
   * `unitConsentSatisfied` (suspension/re-enable): that asks whether a
   * unit's consent still satisfies the MANIFEST (and treats a check whose
   * catalog row vanished as `Low` so a deleted row cannot suspend a unit);
   * this asks which grants confer AUTHORITY, and a grant with no catalog
   * row confers nothing because there is no `Permission` row to build a
   * rule from. They share `riskCovers`; the missing-row asymmetry is the
   * questions differing, not drift.
   */
  async getPluginGrantSnapshot(pluginId: string, unit: PluginUnit): Promise<PluginGrantSnapshot | null> {
    // Independent reads — the unit-enablement row is keyed by (unit, pluginId)
    // and does not need the plugin row first.
    const [plugin, unitServed] = await Promise.all([
      this.db.plugin.findUnique({
        where: { id: pluginId },
        select: { id: true, slug: true, enabled: true, uninstalledAt: true },
      }),
      this.isUnitServed(pluginId, unit),
    ]);

    if (!plugin) {
      return null;
    }

    const base = { plugin: { id: plugin.id, slug: plugin.slug }, unit };
    const servable = plugin.enabled && plugin.uninstalledAt === null && unitServed;

    if (!servable) {
      return { ...base, servable: false, corePermissions: [], ownGrantSlugs: [] };
    }

    const grants = await this.db.pluginGrant.findMany({
      where: {
        pluginId,
        status: PluginGrantStatus.Granted,
        OR: grantScopeCoordinatesForUnit(unit),
      },
      select: { permissionSlug: true, decidedRiskLevel: true, scopeType: true },
    });

    if (grants.length === 0) {
      return { ...base, servable: true, corePermissions: [], ownGrantSlugs: [] };
    }

    const ownSlugs = new Set(grants.map((grant) => grant.permissionSlug).filter(isPluginPermissionSlug));
    const coreSlugs = grants.map((grant) => grant.permissionSlug).filter((slug) => !ownSlugs.has(slug));

    // Corruption check BEFORE the catalog read: a grant row keyed to this
    // plugin whose canonical slug names another plugin's namespace would
    // otherwise vanish here — the pluginId-filtered catalog query finds no
    // row, and the "no catalog row" debug below reads as a benign deleted
    // permission. That is grant-table corruption, not drift, and it takes
    // the same loud typed path the factory uses, not a debug line.
    for (const slug of ownSlugs) {
      const rejection = (reason: 'foreign-namespace-slug' | 'malformed-slug') =>
        new PluginAbilityRenderRejectionError({
          reason,
          pluginId: plugin.id,
          pluginSlug: plugin.slug,
          permissionSlug: slug,
          unit,
        });

      let namespaceSlug: string;
      try {
        namespaceSlug = parsePluginPermissionSlug(slug).pluginSlug;
      } catch (error) {
        // `isPluginPermissionSlug` is a bare prefix test; a `plugin|` row
        // that does not parse is the same corruption class and must take
        // the same typed path, not escape as a raw RangeError (a 500).
        if (error instanceof RangeError) {
          throw rejection('malformed-slug');
        }

        throw error;
      }

      if (namespaceSlug !== plugin.slug) {
        throw rejection('foreign-namespace-slug');
      }
    }

    const [corePermissions, ownPermissions] = await Promise.all([
      coreSlugs.length > 0 ? this.db.permission.findMany({ where: { slug: { in: coreSlugs } } }) : [],
      ownSlugs.size > 0
        ? this.db.pluginPermission.findMany({
            where: { pluginId, slug: { in: [...ownSlugs] } },
            select: { slug: true, riskLevel: true },
          })
        : [],
    ]);

    const currentRiskBySlug = new Map<string, RiskLevel>([
      ...corePermissions.map((permission) => [permission.slug, permission.riskLevel] as const),
      ...ownPermissions.map((permission) => [permission.slug, permission.riskLevel] as const),
    ]);

    // Wildcard-subject re-check at consumption: grant-time forbids wildcard
    // subjects outright, so a granted core slug now carrying `all` can
    // only mean the catalog row drifted after consent. Same posture as the
    // riskCovers guard — the decision no longer describes the permission —
    // but warned rather than debug-logged, because it is always anomalous.
    const wildcardSlugs = new Set(
      corePermissions.filter((permission) => permission.subject === 'all').map((permission) => permission.slug),
    );
    for (const slug of wildcardSlugs) {
      this.logger.warn(
        `Plugin ${pluginId} grant over '${slug}' points at a permission whose subject drifted to the ` +
          `'all' wildcard after consent; conferring nothing`,
      );
    }

    // Unit-boundedness: a Household/User-scope grant confers a core
    // permission only when the catalog row carries SOME bounding clause. A
    // condition-free permission is an unscoped type-level rule — subject-wide
    // authority — and nothing a unit consents to can bound subject-wide reach
    // to that unit's slice, so one user's consent must never read as
    // server-wide access (#60). Server-scope grants are exempt: server
    // consent IS server-wide authority, exactly what install/approval
    // seeding records. Own-namespace slugs never appear in this set — their
    // subjects are enveloped per plugin, scoped by construction.
    const unconditionedCoreSlugs = new Set(
      corePermissions.filter((permission) => !hasBoundingConditions(permission.conditions)).map((p) => p.slug),
    );

    // A slug can be granted at more than one scope (e.g. Server and the
    // unit); it confers when ANY of its grants still covers current risk.
    const conferringSlugs = new Set<string>();
    for (const grant of grants) {
      if (wildcardSlugs.has(grant.permissionSlug)) {
        continue;
      }

      if (grant.scopeType !== PluginGrantScope.Server && unconditionedCoreSlugs.has(grant.permissionSlug)) {
        this.logger.warn(
          `Plugin ${pluginId} grant over '${grant.permissionSlug}' at ${grant.scopeType} scope names a ` +
            'condition-free permission; nothing bounds that authority to the consenting unit — conferring ' +
            'nothing (seed a unit-conditioned variant instead, #315)',
        );
        continue;
      }

      const currentRisk = currentRiskBySlug.get(grant.permissionSlug);

      if (currentRisk === undefined) {
        this.logger.debug(
          `Plugin ${pluginId} grant over '${grant.permissionSlug}' has no catalog row; conferring nothing`,
        );
        continue;
      }

      if (!riskCovers(grant.decidedRiskLevel, currentRisk)) {
        this.logger.debug(
          `Plugin ${pluginId} grant over '${grant.permissionSlug}' was decided at ${grant.decidedRiskLevel} ` +
            `but the permission now carries ${currentRisk}; conferring nothing until re-consent`,
        );
        continue;
      }

      conferringSlugs.add(grant.permissionSlug);
    }

    return {
      ...base,
      servable: true,
      corePermissions: corePermissions.filter((permission) => conferringSlugs.has(permission.slug)),
      ownGrantSlugs: [...ownSlugs].filter((slug) => conferringSlugs.has(slug)),
    };
  }

  /**
   * The unit half of the serving predicate: `enabled && !suspendedForConsent`
   * on the unit's enablement row (#225), read through the shared
   * `loadPluginUnitEnablement` so this predicate and the feature-state
   * derivation cannot drift on what "served" means.
   */
  private async isUnitServed(pluginId: string, unit: PluginUnit): Promise<boolean> {
    const state = await loadPluginUnitEnablement(this.db, pluginId, unit);

    return state.enabled && !state.suspendedForConsent;
  }

  private loadApiKeyGraph(apiKeyId: string) {
    return this.db.apikey.findUnique({
      where: { id: apiKeyId },
      include: {
        scopes: {
          include: {
            permission: {
              select: { action: true, subject: true, inverted: true },
            },
          },
        },
      },
    });
  }
}
