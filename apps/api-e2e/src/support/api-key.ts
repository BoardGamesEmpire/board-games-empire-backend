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

/**
 * The grants a key holds, every one on the same resource type, and on the one
 * resource `resourceId` names when it is given.
 *
 * `POST /api/api-keys` takes the resource type from the permission, so
 * `mintApiKey` doesn't send `resourceType`. It stays here because
 * `arrangeApiKeyScopes` writes it, and so the specs naming it don't change
 * (#1418).
 */
export interface ApiKeyScope {
  readonly resourceId?: string;
  readonly resourceType: ResourceType;
  readonly slugs: readonly string[];
}

const scopeList = (scope?: ApiKeyScope | readonly ApiKeyScope[]): readonly ApiKeyScope[] =>
  scope === undefined ? [] : 'slugs' in scope ? [scope] : scope;

/**
 * A key `owner` mints at `POST /api/api-keys`, as they would mint it
 * themselves, holding the grants in `scope` and nothing else (#1418). With no
 * scope it holds none, and every policy-checked route denies it. Several scopes
 * give a key grants that differ by resource: `read` on every subscription
 * beside `manage` on one, say.
 *
 * The route refuses a slug the owner can't grant, or a pin on a type that
 * takes none; such a key needs `mintApiKeyWithArrangedScopes`. It confirms a
 * Critical permission, which the e2e actors' fresh sessions allow. A key the
 * route mints expires in its default 90 days. Moving this into
 * `@bge/testing-e2e` as an actor factory is #270.
 */
export const mintApiKey = async (
  baseUrl: string,
  prisma: PrismaClient,
  owner: SessionActor,
  scope?: ApiKeyScope | readonly ApiKeyScope[],
): Promise<ApiKeyCaller> => {
  const scopes = scopeList(scope).flatMap(({ slugs, resourceId }) =>
    slugs.map((slug) => (resourceId === undefined ? { slug } : { slug, resourceId })),
  );

  const response = await request(baseUrl)
    .post('/api/api-keys')
    .set(owner.headers)
    .send({ name: 'e2e', scopes, confirmCritical: true });

  if (
    response.status !== 201 ||
    typeof response.body?.secret !== 'string' ||
    typeof response.body?.apiKey?.id !== 'string'
  ) {
    throw new Error(`minting a key failed: ${response.status} ${JSON.stringify(response.body)}`);
  }

  return { id: response.body.apiKey.id, headers: { [API_KEY_HEADER]: response.body.secret } };
};

/**
 * Writes key scope rows for `apiKeyId` straight to the database, past the
 * route's checks. It is for a spec that shows a route fails closed for a key
 * scope `POST /api/api-keys` refuses: a pin on a type off the pinnable list,
 * or a slug the owner doesn't hold. Or that a pin the route refuses today
 * still narrows the key: the e2e a type needs before it joins the pinnable
 * list (#1418).
 */
export const arrangeApiKeyScopes = async (
  prisma: PrismaClient,
  apiKeyId: string,
  scope: ApiKeyScope | readonly ApiKeyScope[],
): Promise<void> => {
  for (const { slugs, resourceType, resourceId } of scopeList(scope)) {
    for (const slug of slugs) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { slug } });

      await prisma.apiKeyScope.create({
        data: {
          apiKeyId,
          permissionId: permission.id,
          resourceType,
          resourceId: resourceId ?? null,
        },
      });
    }
  }
};

/**
 * `mintApiKey` with no key scope, then `arrangeApiKeyScopes` for `scope`: a
 * key holding scopes the route would refuse (#1418).
 */
export const mintApiKeyWithArrangedScopes = async (
  baseUrl: string,
  prisma: PrismaClient,
  owner: SessionActor,
  scope: ApiKeyScope | readonly ApiKeyScope[],
): Promise<ApiKeyCaller> => {
  const key = await mintApiKey(baseUrl, prisma, owner);
  await arrangeApiKeyScopes(prisma, key.id, scope);

  return key;
};
