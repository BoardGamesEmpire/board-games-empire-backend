import { DatabaseService } from '@bge/database';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import type { ApikeyWithScopes, UserWithRoles } from './interfaces';

@Injectable()
export class PermissionsService {
  private readonly logger = new Logger(PermissionsService.name);

  private static readonly CACHE_TTL_IN_MILLISECONDS = 5 * 60 * 1000;

  constructor(
    private readonly db: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async getUserRoleGraph(userId: string): Promise<UserWithRoles | null> {
    const userGraph = await this.getOrLoad(`bge:user:permissions:${userId}`, `user role graph for user ${userId}`, () =>
      this.loadUserGraph(userId),
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
   */
  private async getOrLoad<T extends object>(
    cacheKey: string,
    label: string,
    loader: () => Promise<T | null>,
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

    this.logger.debug(`Loaded ${label} from database, caching result`);
    await this.cache.set(cacheKey, fresh, PermissionsService.CACHE_TTL_IN_MILLISECONDS);

    return fresh;
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
