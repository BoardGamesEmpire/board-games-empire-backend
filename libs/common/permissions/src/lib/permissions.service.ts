import { DatabaseService } from '@bge/database';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import type { ApikeyWithScopes, UserWithRoles } from './interfaces';

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

  constructor(
    private readonly db: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async getUserRoleGraph(userId: string): Promise<UserWithRoles | null> {
    const userGraph = await this.getOrLoad(
      `bge:user:permissions:${userId}`,
      `user role graph for user ${userId}`,
      () => this.loadUserGraph(userId),
      (graph) => this.cacheTtlForGraph(graph),
    );

    return userGraph as UserWithRoles | null;
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
