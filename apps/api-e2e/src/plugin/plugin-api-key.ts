import { ResourceType, type PrismaClient } from '@bge/database';
import type { SessionActor } from '@bge/testing-e2e';
import request from 'supertest';

/** Whoever sends the request: a session, or an API key. */
export interface Caller {
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * An API key of `owner`'s, scoped to the household plugin routes and nothing
 * else, so it holds no read on Household. The household liveness guard passes
 * such a key through untouched: it was never told which households exist.
 *
 * Minted the way `auth/api-key.spec.ts` mints its keys, scope rows arranged
 * directly because no route writes them yet (#266, and #270 for the fixture).
 */
export const householdPluginKey = async (
  baseUrl: string,
  prisma: PrismaClient,
  owner: SessionActor,
): Promise<Caller> => {
  const response = await request(baseUrl)
    .post('/api/auth/api-key/create')
    .set('Origin', baseUrl)
    .set(owner.headers)
    .send({ name: 'e2e' });

  if (response.status !== 200 || typeof response.body?.key !== 'string') {
    throw new Error(`minting a key failed: ${response.status} ${JSON.stringify(response.body)}`);
  }

  for (const slug of ['read:plugin:household', 'manage:plugin:household']) {
    const permission = await prisma.permission.findUniqueOrThrow({ where: { slug } });

    await prisma.apiKeyScope.create({
      data: { apiKeyId: response.body.id, permissionId: permission.id, resourceType: ResourceType.HouseholdPlugin },
    });
  }

  return { headers: { 'x-api-key': response.body.key } };
};
