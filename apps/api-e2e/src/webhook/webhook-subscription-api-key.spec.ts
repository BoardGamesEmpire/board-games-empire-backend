import { ResourceType } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { WebhookEventType } from '@bge/webhooks';
import request from 'supertest';
import { mintApiKey, type ApiKeyScope, type Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { subscriptionEnvelope } from './webhook-wire';

const SUBSCRIPTIONS_PATH = '/api/webhooks/subscriptions';

/** Never contacted: the API runs no consumer, so nothing here is delivered. */
const RECEIVER_URL = 'https://receiver.e2e.invalid/bge';

/** The refusal of a key's write to a webhook subscription it didn't make, not a ceiling's. */
const OTHER_KEY_REFUSAL = 'This API key can change only the webhook subscriptions it made';

/**
 * A webhook subscription made through an API key, over the real routes
 * (#723). The webhook subscription records the key, and a write through a key
 * reaches only that key's own webhook subscriptions, so the reach one was made
 * with never changes after it is made.
 */
describe('webhook subscriptions made through an API key (#723)', () => {
  const baseUrl = requireBaseUrl(process.env);

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  /** What a key needs to make a webhook subscription to household ownership transfers. */
  const subscribingScope = (...extra: ApiKeyScope[]): ApiKeyScope[] => [
    { slugs: ['manage:webhook_subscription:own'], resourceType: ResourceType.WebhookSubscription },
    ...extra,
  ];

  const subscribe = async (caller: Caller): Promise<string> => {
    const response = await request(baseUrl)
      .post(SUBSCRIPTIONS_PATH)
      .set(caller.headers)
      .send({
        url: RECEIVER_URL,
        resourceType: ResourceType.Household,
        eventTypes: [WebhookEventType.HouseholdOwnershipTransferred],
      })
      .expect(201);

    return subscriptionEnvelope(response, `POST ${SUBSCRIPTIONS_PATH}`).id;
  };

  const move = (caller: Caller, id: string, url: string) =>
    request(baseUrl).patch(`${SUBSCRIPTIONS_PATH}/${id}`).set(caller.headers).send({ url });

  const stored = (id: string) =>
    db.client.webhookSubscription.findUniqueOrThrow({ where: { id }, select: { url: true, apiKeyId: true } });

  const keyOf = (owner: SessionActor) =>
    mintApiKey(
      baseUrl,
      db.client,
      owner,
      subscribingScope({ slugs: ['read:households'], resourceType: ResourceType.Household }),
    );

  describe('making and changing a webhook subscription', () => {
    it('records the key that made a webhook subscription', async () => {
      const owner = await actors.user();
      const key = await keyOf(owner);

      expect((await stored(await subscribe(key))).apiKeyId).toBe(key.id);
      // The control: the key owner's session records no key.
      expect((await stored(await subscribe(owner))).apiKeyId).toBeNull();
    });

    it('refuses a key a change to a webhook subscription the key owner’s session made', async () => {
      const owner = await actors.user();
      const key = await keyOf(owner);
      const subscriptionId = await subscribe(owner);

      const refused = await move(key, subscriptionId, 'https://receiver.e2e.invalid/moved').expect(403);
      expect(refused.body.message).toBe(OTHER_KEY_REFUSAL);
      expect((await stored(subscriptionId)).url).toBe(RECEIVER_URL);

      // The control: the key owner's session changes it.
      await move(owner, subscriptionId, 'https://receiver.e2e.invalid/moved').expect(200);
    });

    it('refuses a key a change to a webhook subscription another key made', async () => {
      const owner = await actors.user();
      const keyA = await keyOf(owner);
      const keyB = await keyOf(owner);
      const subscriptionId = await subscribe(keyA);

      const refused = await move(keyB, subscriptionId, 'https://receiver.e2e.invalid/moved').expect(403);
      expect(refused.body.message).toBe(OTHER_KEY_REFUSAL);
      expect((await stored(subscriptionId)).url).toBe(RECEIVER_URL);

      // The control: the key that made it changes it.
      await move(keyA, subscriptionId, 'https://receiver.e2e.invalid/moved').expect(200);
    });

    it('leaves the key on a webhook subscription the key owner’s session changes', async () => {
      const owner = await actors.user();
      const key = await keyOf(owner);
      const subscriptionId = await subscribe(key);

      await move(owner, subscriptionId, 'https://receiver.e2e.invalid/moved').expect(200);

      expect(await stored(subscriptionId)).toEqual({ url: 'https://receiver.e2e.invalid/moved', apiKeyId: key.id });
    });
  });
});
