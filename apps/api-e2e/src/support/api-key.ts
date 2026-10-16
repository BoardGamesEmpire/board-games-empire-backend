import type { PrismaClient, ResourceType } from '@bge/database';
import type { SessionActor } from '@bge/testing-e2e';
import request from 'supertest';

export const API_KEY_HEADER = 'x-api-key';

/** Whoever sends the request: a session, or an API key. */
export interface Caller {
  readonly headers: Readonly<Record<string, string>>;
}

/** A minted key: its headers, and its id, which names it in the response cache. */
export interface ApiKeyCaller extends Caller {
  readonly id: string;
}

/** The grants a key holds, every one on the same resource type. */
export interface ApiKeyScope {
  readonly slugs: readonly string[];
  readonly resourceType: ResourceType;
}

/**
 * A key `owner` mints through better-auth's own route, as they would mint it
 * themselves, holding the grants in `scope` and nothing else. With no scope
 * it holds none, and every policy-checked route denies it.
 *
 * No route writes a key's scope rows yet (#266), so they are arranged
 * directly. Moving this into `@bge/testing-e2e` as an actor factory is #270.
 */
export const mintApiKey = async (
  baseUrl: string,
  prisma: PrismaClient,
  owner: SessionActor,
  scope?: ApiKeyScope,
): Promise<ApiKeyCaller> => {
  const response = await request(baseUrl)
    .post('/api/auth/api-key/create')
    .set('Origin', baseUrl)
    .set(owner.headers)
    .send({ name: 'e2e' });

  if (response.status !== 200 || typeof response.body?.key !== 'string') {
    throw new Error(`minting a key failed: ${response.status} ${JSON.stringify(response.body)}`);
  }

  if (scope !== undefined) {
    for (const slug of scope.slugs) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { slug } });

      await prisma.apiKeyScope.create({
        data: { apiKeyId: response.body.id, permissionId: permission.id, resourceType: scope.resourceType },
      });
    }
  }

  return { id: response.body.id, headers: { [API_KEY_HEADER]: response.body.key } };
};
