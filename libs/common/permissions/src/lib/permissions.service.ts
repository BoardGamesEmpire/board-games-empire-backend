import type { PluginUnit } from '@bge/actor-context';
import {
  bindsConsentUnit,
  CONSENT_UNIT_BINDING_REFUSAL,
  DatabaseService,
  grantScopeCoordinatesForUnit,
  loadPluginUnitEnablement,
  PLUGIN_REQUESTED_PERMISSIONS_READER,
  PluginGrantScope,
  PluginGrantStatus,
  Prisma,
  riskCovers,
  type PluginRequestedPermissionsReader,
  type RiskLevel,
} from '@bge/database';
import { isPluginPermissionSlug, parsePluginPermissionSlug } from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { randomUUID } from 'node:crypto';
import { PluginAbilityRenderRejectionError } from './errors/plugin-ability-render-rejection.error';
import type { ApikeyWithScopes, PluginGrantSnapshot, UserWithRoles } from './interfaces';
import { PERMISSIONS_CACHE } from './permissions-cache';

/**
 * What {@link PermissionsService.getOrLoad} caches: the loaded value, tagged
 * with the version token its key held before the load began.
 */
interface VersionedEntry<T> {
  version: string;
  value: T;
}

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

  /**
   * How long a version token lives. A token that expires, or that the cache
   * drops sooner, costs one reload: the next read writes a fresh token, and
   * nothing cached under the old one matches it.
   */
  static readonly CACHE_VERSION_TTL_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

  constructor(
    private readonly db: DatabaseService,
    @Inject(PERMISSIONS_CACHE) private readonly cache: Cache,
    /**
     * Provided by the plugin runtime (#577). Optional because this lib cannot
     * import the runtime, and a process without it confers nothing on plugin
     * actors rather than every decision on file.
     */
    @Optional()
    @Inject(PLUGIN_REQUESTED_PERMISSIONS_READER)
    private readonly requestedPermissionsReader?: PluginRequestedPermissionsReader,
  ) {}

  /**
   * Cache key for a user's resolved permission graph. Single source of truth for
   * the key format — both the writer ({@link getUserRoleGraph}) and every
   * invalidation path go through here so the two can never drift.
   */
  static userGraphCacheKey(userId: string): string {
    return `bge:user:permissions:${userId}`;
  }

  /**
   * Cache key for an API key's resolved scope graph; the same single source of
   * truth as {@link userGraphCacheKey}. The boot sequence's flush (#236) scans
   * both formats, with the cache store's namespace in front.
   */
  static apiKeyScopeCacheKey(apiKeyId: string): string {
    return `bge:apikey:scopes:${apiKeyId}`;
  }

  /**
   * Key of the version token that guards `cacheKey`'s entry: an eviction
   * writes a fresh token here, and a cached entry counts as a hit only while
   * it carries the current one. The boot sequence's flush (#236) removes these
   * with the entries they guard.
   */
  static cacheVersionKey(cacheKey: string): string {
    return `bge:cache-version:${cacheKey}`;
  }

  async getUserRoleGraph(userId: string): Promise<UserWithRoles | null> {
    const userGraph = await this.getOrLoad(
      PermissionsService.userGraphCacheKey(userId),
      `user role graph for user ${userId}`,
      () => this.loadUserGraph(this.db, userId),
      (graph) => this.cacheTtlForGraph(graph),
      // A graph holding no global role was read before its user's provisioning
      // committed (#490): every provisioned user holds one, and provisioning
      // writes them all in one transaction. Caching it would refuse that user
      // for the whole TTL after their roles exist, and nothing would say why.
      // Served, not cached: the request is refused, and the next one reloads.
      // Provisioning's eviction after its commit covers this too, since the
      // graph would carry the token that eviction replaced. This check doesn't
      // depend on the eviction running at all.
      (graph) => graph.roles.length > 0,
    );

    return userGraph as UserWithRoles | null;
  }

  /**
   * A user's permission graph as `tx` reads it, never from the cache and
   * never cached: for asking about a user other than the actor at the moment
   * a decision is made, when their roles may have changed a moment ago (#747).
   * A role change evicts the cached graph only after it commits, so a cached
   * read can still hold the role it replaced. Inside a transaction holding a
   * lock the change also takes, this read sees exactly what committed.
   *
   * A user under a ban in force reads as no graph, as a deleted one does: they
   * can neither sign in nor use a key, so they could do nothing now. The rule
   * is the one better-auth applies at sign-in and the API key middleware
   * applies per request: banned with no expiry, or with one still to come.
   */
  async loadUserRoleGraphWithin(tx: Prisma.TransactionClient, userId: string): Promise<UserWithRoles | null> {
    return (await this.loadUserGraph(tx, userId, PermissionsService.notBannedNow())) as UserWithRoles | null;
  }

  /**
   * Several users' graphs as they have committed, read as
   * {@link loadUserRoleGraphWithin} reads one but in a single read for them
   * all: for judging many users at once, as the webhook dispatcher judges
   * every subscriber to an event (#732). A user under a ban in force, or one
   * deleted, is missing from the map. Every graph read is held at once, and a
   * graph is large (#921), so a caller with many users passes a batch at a time.
   */
  async loadUserRoleGraphs(userIds: readonly string[]): Promise<Map<string, UserWithRoles>> {
    if (userIds.length === 0) {
      return new Map();
    }

    const graphs = (await this.db.user.findMany({
      where: { id: { in: [...userIds] }, AND: PermissionsService.notBannedNow() },
      select: PermissionsService.userGraphSelect(),
    })) as UserWithRoles[];

    return new Map(graphs.map((graph) => [graph.id, graph]));
  }

  /** Not banned, or banned with an expiry already past. */
  private static notBannedNow(): Prisma.UserWhereInput {
    return { OR: [{ banned: null }, { banned: false }, { banExpires: { lte: new Date() } }] };
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
   * is logged only when both cache calls resolve without error — the cache API
   * doesn't report whether a key was present, so it reflects a completed
   * invalidation (the graph is now absent), not a confirmed prior cache hit.
   */
  private async evictUserGraph(userId: string): Promise<void> {
    const label = `permission graph for user ${userId}`;

    if (await this.evict(PermissionsService.userGraphCacheKey(userId), label)) {
      this.logger.debug(`Invalidated ${label}`);
    }
  }

  /**
   * Deletes `cacheKey`'s entry and writes a fresh version token for it.
   * Resolves whether both succeeded, logging each failure on its own line,
   * since each leaves a different gap.
   *
   * The delete alone loses a race. A load that read the database before the
   * change committed can write its result after this delete, and that result
   * would be served until the TTL. The token closes it: the load is tagged
   * with the token its key held before the load began, which this call
   * replaces, so its late write never counts as a hit (#588).
   */
  private async evict(cacheKey: string, label: string): Promise<boolean> {
    const [versionWrite, deletion] = await Promise.allSettled([
      this.writeVersionToken(cacheKey),
      this.cache.del(cacheKey),
    ]);

    if (deletion.status === 'rejected') {
      this.logger.error(`Failed to delete the cached ${label}`, deletion.reason);
    }

    if (versionWrite.status === 'rejected') {
      this.logger.error(
        `Failed to replace the version token of the ${label}: a load that began before this change can still cache what it read`,
        versionWrite.reason,
      );
    }

    return deletion.status === 'fulfilled' && versionWrite.status === 'fulfilled';
  }

  /**
   * Writes a fresh version token for `cacheKey` and resolves it.
   *
   * The token is random, not a counter. Through the cache API an increment is
   * a read then a write, so a slow eviction could set the count back to one a
   * stale load is tagged with. A fresh random token never matches an earlier
   * tag.
   */
  private async writeVersionToken(cacheKey: string): Promise<string> {
    const token = randomUUID();

    await this.cache.set(
      PermissionsService.cacheVersionKey(cacheKey),
      token,
      PermissionsService.CACHE_VERSION_TTL_IN_MILLISECONDS,
    );

    return token;
  }

  /**
   * Loads an API key with its scopes and each scope's permission
   * (action/subject/inverted/fields) — the shape `AbilityFactory.createForApiKey`
   * consumes. The actor only carries the key id, so the scope graph must be
   * resolved here.
   *
   * Returns `null` when the key no longer exists (e.g. revoked between auth and
   * ability resolution); the caller fails loud rather than building a
   * permissive ability from a missing key.
   */
  async getApiKeyScopeGraph(apiKeyId: string): Promise<ApikeyWithScopes | null> {
    const apiKey = await this.getOrLoad(
      PermissionsService.apiKeyScopeCacheKey(apiKeyId),
      `API key scope graph for key ${apiKeyId}`,
      () => this.loadApiKeyGraph(apiKeyId),
    );

    return apiKey as ApikeyWithScopes | null;
  }

  /**
   * Several API keys' scope graphs as they have committed, never from the
   * cache and never cached: for judging a webhook subscription made through a
   * key at dispatch, as {@link loadUserRoleGraphs} judges its owner (#723). A
   * key that is deleted, disabled or past its expiry is missing from the map.
   * A key whose `enabled` is unset counts as enabled, as better-auth's own
   * check counts it.
   */
  async loadApiKeyScopeGraphs(apiKeyIds: readonly string[]): Promise<Map<string, ApikeyWithScopes>> {
    if (apiKeyIds.length === 0) {
      return new Map();
    }

    const keys = await this.db.apikey.findMany({
      where: {
        id: { in: [...apiKeyIds] },
        AND: [
          { OR: [{ enabled: null }, { enabled: true }] },
          { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        ],
      },
      include: PermissionsService.apiKeyGraphInclude(),
    });

    return new Map(keys.map((key) => [key.id, key]));
  }

  /**
   * Cache-aside loader shared by the permission graphs: serve a cache hit,
   * otherwise run `loader` and cache only a non-null result. A missing row is
   * never negatively cached and surfaces as `null` for the caller to handle.
   *
   * A cached entry is a hit only while it carries its key's current version
   * token ({@link cacheVersionKey}). The entry and the token are read in one
   * round trip, before the loader runs, and a miss caches the result tagged
   * with the token read then. An eviction that lands while the loader runs
   * replaces that token, so what the loader read is never served from the
   * cache afterwards (#588).
   *
   * A miss on a key that holds no token writes one before the loader runs and
   * tags the result with it, so nothing is cached as "no token". The key holds
   * none until something evicts it, and again once its token expires or the
   * cache drops it. Were "no token" a tag, a token lost after an eviction
   * would make a load that eviction overtook a hit again.
   *
   * `ttlFor` lets a caller derive a per-entry TTL from the loaded value (used to
   * clamp the user graph to a soon-to-expire permission); it defaults to the
   * static TTL. `cacheable` lets a caller serve a value without caching it
   * (used for a user graph read before provisioning committed); by default
   * every non-null value is cached.
   */
  private async getOrLoad<T extends object>(
    cacheKey: string,
    label: string,
    loader: () => Promise<T | null>,
    ttlFor: (value: T) => number = () => PermissionsService.CACHE_TTL_IN_MILLISECONDS,
    cacheable: (value: T) => boolean = () => true,
  ): Promise<T | null> {
    const [cached, currentVersion] = (await this.cache.mget([
      cacheKey,
      PermissionsService.cacheVersionKey(cacheKey),
    ])) as [VersionedEntry<T> | undefined, string | undefined];

    if (currentVersion !== undefined && cached?.version === currentVersion) {
      this.logger.debug(`Cache hit for ${label}`);
      return cached.value;
    }

    if (cached) {
      this.logger.debug(`Cached ${label} doesn't carry its current version token, reloading`);
    }

    const version = currentVersion ?? (await this.writeVersionToken(cacheKey));
    const fresh = await loader();
    if (!fresh) {
      this.logger.warn(`Not found while loading ${label}`);
      return null;
    }

    if (!cacheable(fresh)) {
      this.logger.debug(`Loaded ${label} from database, not caching it`);
      return fresh;
    }

    const ttl = ttlFor(fresh);
    this.logger.debug(`Loaded ${label} from database, caching result (ttl=${ttl}ms)`);
    await this.cache.set<VersionedEntry<T>>(cacheKey, { version, value: fresh }, ttl);

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

  private loadUserGraph(
    client: DatabaseService | Prisma.TransactionClient,
    userId: string,
    standing?: Prisma.UserWhereInput,
  ) {
    return client.user.findUnique({
      where: { id: userId, ...(standing && { AND: standing }) },
      select: PermissionsService.userGraphSelect(),
    });
  }

  /**
   * What a user's permission graph is read with. Every role → permission hop
   * filters `permission.retiredAt: null` (#235): a retired catalog row keeps
   * whatever grants still reference it and confers nothing through any of
   * them.
   */
  private static userGraphSelect() {
    return {
      id: true,
      roles: {
        select: {
          role: {
            select: {
              name: true,
              permissions: {
                where: { permission: { retiredAt: null } },
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
                    where: { permission: { retiredAt: null } },
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
                    where: { permission: { retiredAt: null } },
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
      // build time as the backstop. An override of a retired permission is
      // excluded the same way (#235).
      permissions: {
        where: {
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          permission: { retiredAt: null },
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
    } satisfies Prisma.UserSelect;
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
   *   core permission only when the row binds the consenting unit
   *   (`bindsConsentUnit`, #591): its conditions restrict it to that unit's
   *   own id, or it is an allowlisted public read. A condition-free row is
   *   subject-wide authority, and a fixed-condition one reaches every
   *   matching row install-wide; only SERVER consent can confer either.
   *   Warned, not debug — the install/update gates and `decide()` refuse to
   *   create such grants, so one existing can only mean the catalog drifted
   *   under a recorded decision.
   * - **Bounded by the active manifest.** A decision confers only while
   *   the active manifest requests that permission at that decision's
   *   scope (#577). Activation deletes decisions on a permission an update
   *   stops requesting, but the bound is applied here as well: a
   *   pre-consent decision, recorded against a pending manifest, must not
   *   confer before its update lands. The manifest is re-validated, never
   *   trusted; one that fails rejects the whole ability.
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
        select: { id: true, slug: true, version: true, manifestJson: true, enabled: true, uninstalledAt: true },
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

    // Corruption check BEFORE the catalog read: a grant row keyed to this
    // plugin whose canonical slug names another plugin's namespace would
    // otherwise vanish here — the pluginId-filtered catalog query finds no
    // row, and the "no catalog row" debug below reads as a benign deleted
    // permission. That is grant-table corruption, not drift, and it takes
    // the same loud typed path the factory uses, not a debug line. It also
    // runs before the manifest bound below, which would otherwise drop such
    // a row quietly: no valid manifest requests another plugin's namespace.
    for (const slug of new Set(grants.map((grant) => grant.permissionSlug).filter(isPluginPermissionSlug))) {
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

    const requestedGrants = this.grantsRequestedByActiveManifest(plugin, unit, grants);
    const ownSlugs = new Set(requestedGrants.map((grant) => grant.permissionSlug).filter(isPluginPermissionSlug));
    const coreSlugs = requestedGrants.map((grant) => grant.permissionSlug).filter((slug) => !ownSlugs.has(slug));

    const [corePermissions, ownPermissions] = await Promise.all([
      // A retired row (#235) is read as missing: the grant survives, confers nothing.
      coreSlugs.length > 0 ? this.db.permission.findMany({ where: { slug: { in: coreSlugs }, retiredAt: null } }) : [],
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
    // permission only when the catalog row binds the consenting unit — its
    // conditions restrict it to that unit's own id, or it is an allowlisted
    // public read (#591). A condition-free permission is subject-wide authority and
    // a fixed-condition one reaches every matching row install-wide; nothing
    // a unit consents to can bound either to that unit's slice, so one
    // user's consent must never read as server-wide access (#60).
    // Server-scope grants are exempt: server consent IS server-wide
    // authority, exactly what install/approval seeding records. Declared
    // permissions never reach this check — their subjects are enveloped per
    // plugin, scoped by construction.
    const corePermissionsBySlug = new Map(corePermissions.map((permission) => [permission.slug, permission] as const));

    // A slug can be granted at more than one scope (e.g. Server and the
    // unit); it confers when ANY of its grants still covers current risk.
    const conferringSlugs = new Set<string>();
    for (const grant of requestedGrants) {
      if (wildcardSlugs.has(grant.permissionSlug)) {
        continue;
      }

      const corePermission = corePermissionsBySlug.get(grant.permissionSlug);

      if (
        grant.scopeType !== PluginGrantScope.Server &&
        corePermission !== undefined &&
        !bindsConsentUnit(corePermission, grant.scopeType)
      ) {
        this.logger.warn(
          `Plugin ${pluginId} grant over '${grant.permissionSlug}' at ${grant.scopeType} scope: ` +
            `${CONSENT_UNIT_BINDING_REFUSAL} — conferring nothing (seed a unit-conditioned variant instead, #315)`,
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
   * The snapshot's manifest bound (#577): keeps only the decisions whose
   * permission the plugin's active manifest requests at that decision's
   * scope. Throws the typed rejection when the stored manifest fails
   * re-validation, and keeps nothing when no reader is registered.
   */
  private grantsRequestedByActiveManifest<TGrant extends { permissionSlug: string; scopeType: PluginGrantScope }>(
    plugin: { id: string; slug: string; version: string; manifestJson: unknown },
    unit: PluginUnit,
    grants: readonly TGrant[],
  ): TGrant[] {
    if (!this.requestedPermissionsReader) {
      this.logger.warn(
        `Plugin ${plugin.id} holds consent decisions, but this process registers no reader for its active ` +
          'manifest; conferring nothing (#577)',
      );

      return [];
    }

    const result = this.requestedPermissionsReader.read({
      slug: plugin.slug,
      version: plugin.version,
      manifestJson: plugin.manifestJson,
    });

    if (!result.valid) {
      throw new PluginAbilityRenderRejectionError({
        reason: 'invalid-stored-manifest',
        pluginId: plugin.id,
        pluginSlug: plugin.slug,
        permissionSlug: null,
        detail: result.detail,
        unit,
      });
    }

    const requested = new Set(result.requested.map(({ slug, scopeType }) => `${scopeType}|${slug}`));

    return grants.filter((grant) => {
      if (requested.has(`${grant.scopeType}|${grant.permissionSlug}`)) {
        return true;
      }

      this.logger.debug(
        `Plugin ${plugin.id} decision on '${grant.permissionSlug}' at ${grant.scopeType} scope is not requested ` +
          'by the active manifest; conferring nothing',
      );

      return false;
    });
  }

  /**
   * The unit half of the serving predicate:
   * `enabled && !suspendedForConsent && dormantReason === null` on the unit's
   * enablement row (#225, #369), read through the shared
   * `loadPluginUnitEnablement` so this predicate and the feature-state
   * derivation cannot drift on what "served" means.
   *
   * Dormancy is the third component and not a variant of the other two: a
   * dormant row is one the manifest moved out from under (a scope narrowing, a
   * schema tightening), so the household's own `enabled` intent survives it and
   * abilities must stop resolving regardless of that intent (D-CK).
   */
  private async isUnitServed(pluginId: string, unit: PluginUnit): Promise<boolean> {
    const state = await loadPluginUnitEnablement(this.db, pluginId, unit);

    return state.enabled && !state.suspendedForConsent && state.dormantReason === null;
  }

  private loadApiKeyGraph(apiKeyId: string) {
    return this.db.apikey.findUnique({
      where: { id: apiKeyId },
      include: PermissionsService.apiKeyGraphInclude(),
    });
  }

  /** What an API key's scope graph is read with. */
  private static apiKeyGraphInclude() {
    return {
      scopes: {
        // A scope over a retired permission (#235) confers nothing.
        where: { permission: { retiredAt: null } },
        include: {
          permission: {
            select: { action: true, subject: true, inverted: true, fields: true },
          },
        },
      },
    } satisfies Prisma.ApikeyInclude;
  }
}
