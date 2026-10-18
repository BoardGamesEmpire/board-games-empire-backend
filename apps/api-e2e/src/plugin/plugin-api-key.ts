import { ResourceType, type PrismaClient } from '@bge/database';
import type { SessionActor } from '@bge/testing-e2e';
import { mintApiKey, type Caller } from '../support/api-key';

/**
 * An API key of `owner`'s, scoped to the household plugin routes and nothing
 * else, so it holds no read on Household. The household liveness guard passes
 * such a key through untouched: it was never told which households exist.
 *
 * It reads `Plugin` as well as `HouseholdPlugin`, as every user does: the
 * household list's rows are plugins, and it refuses a caller with no rule on
 * them rather than serve an empty page.
 */
export const householdPluginKey = (baseUrl: string, prisma: PrismaClient, owner: SessionActor): Promise<Caller> =>
  mintApiKey(baseUrl, prisma, owner, [
    { slugs: ['read:plugin:household', 'manage:plugin:household'], resourceType: ResourceType.HouseholdPlugin },
    { slugs: ['read:plugin:installed'], resourceType: ResourceType.Plugin },
  ]);
