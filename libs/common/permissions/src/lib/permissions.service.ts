import { DatabaseService } from '@bge/database';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import type { UserWithRoles } from './interfaces';

@Injectable()
export class PermissionsService {
  private readonly logger = new Logger(PermissionsService.name);

  constructor(private readonly db: DatabaseService, @Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  async getUserRoleGraph(userId: string) {
    const cacheKey = `bge:user:permissions:${userId}`;
    const cachedGraph = await this.cache.get<UserWithRoles>(cacheKey);
    if (cachedGraph) {
      this.logger.debug(`User role graph cache hit for user ${userId}`);
      return cachedGraph;
    }

    const userGraph = await this.db.user.findUnique({
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

    this.logger.debug(`Fetched user role graph for user ${userId}: ${JSON.stringify(userGraph)}`);

    const CACHE_TTL_IN_MILLISECONDS = 5 * 60 * 1000;
    await this.cache.set(cacheKey, userGraph, CACHE_TTL_IN_MILLISECONDS);

    return userGraph as UserWithRoles;
  }
}
