import { ResourceType } from '@bge/database';
import { createActors, type Actors } from '@bge/testing-e2e';
import request from 'supertest';
import { mintApiKey, type Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { listSubscriptionsEnvelope, subscriptionEnvelope } from './webhook-wire';

/**
 * What an API key scoped to some of its owner's webhook subscriptions may
 * list and change, over the real routes (#515, #590).
 *
 * For a session nothing changed: the ceiling and the owner filter coincide.
 * A key carries a narrower ceiling, and the routes used to ignore it: the list
 * filtered on the key's owner alone, and each write updated the row by id
 * after reading it through the owner filter. So a key scoped to one
 * subscription listed all of them, and a key that may read every subscription
 * but manage only one could change any of them.
 *
 * The subscriptions are arranged directly: creating one checks event-type
 * grants, which are not under test.
 */
describe('webhook subscription scope for API keys', () => {
  const baseUrl = requireBaseUrl(process.env);
  const SUBSCRIPTIONS_PATH = '/api/webhooks/subscriptions';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const listSubscriptions = (caller: Caller) => request(baseUrl).get(SUBSCRIPTIONS_PATH).set(caller.headers);

  const readSubscription = (caller: Caller, id: string) =>
    request(baseUrl).get(`${SUBSCRIPTIONS_PATH}/${id}`).set(caller.headers);

  const moveSubscription = (caller: Caller, id: string, url: string) =>
    request(baseUrl).patch(`${SUBSCRIPTIONS_PATH}/${id}`).set(caller.headers).send({ url });

  const subscription = async (createdById: string, url: string) =>
    (
      await db.client.webhookSubscription.create({
        data: { url, secret: 'stored-ciphertext-never-read', resourceType: ResourceType.Event, createdById },
        select: { id: true },
      })
    ).id;

  /** An owner with two subscriptions, `scoped` and `other`. */
  const arrange = async () => {
    const owner = await actors.user();
    const scoped = await subscription(owner.user.id, 'https://hooks.example.com/scoped');
    const other = await subscription(owner.user.id, 'https://hooks.example.com/other');

    return { owner, scoped, other };
  };

  it('lists a key scoped to one subscription only that one', async () => {
    const { owner, scoped, other } = await arrange();
    const key = await mintApiKey(baseUrl, db.client, owner, {
      slugs: ['read:webhook_subscription:own'],
      resourceType: ResourceType.WebhookSubscription,
      resourceId: scoped,
    });

    // The control: the owner's session lists both.
    const all = listSubscriptionsEnvelope(
      await listSubscriptions(owner).expect(200),
      'GET /api/webhooks/subscriptions as their owner',
    );
    expect(all.map((each) => each.id).sort()).toEqual([scoped, other].sort());

    const page = listSubscriptionsEnvelope(
      await listSubscriptions(key).expect(200),
      'GET /api/webhooks/subscriptions with a scoped key',
    );
    expect(page.map((each) => each.id)).toEqual([scoped]);
  });

  it('refuses a key that may read every subscription but manage one a change to another', async () => {
    const { owner, scoped, other } = await arrange();
    const key = await mintApiKey(baseUrl, db.client, owner, [
      { slugs: ['read:webhook_subscription:own'], resourceType: ResourceType.WebhookSubscription },
      {
        slugs: ['manage:webhook_subscription:own'],
        resourceType: ResourceType.WebhookSubscription,
        resourceId: scoped,
      },
    ]);

    await moveSubscription(key, other, 'https://hooks.example.com/moved').expect(403);

    // The refused write changed nothing, as the key itself reads it back.
    const unchanged = subscriptionEnvelope(
      await readSubscription(key, other).expect(200),
      'GET /api/webhooks/subscriptions/:id with the key',
    );
    expect(unchanged.url).toBe('https://hooks.example.com/other');

    // The control: the same key changes the subscription it may manage.
    const moved = subscriptionEnvelope(
      await moveSubscription(key, scoped, 'https://hooks.example.com/moved').expect(200),
      'PATCH /api/webhooks/subscriptions/:id with the key',
    );
    expect(moved.url).toBe('https://hooks.example.com/moved');
  });
});
