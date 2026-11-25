import { ResourceType } from '@bge/database';
import type { Actors } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import { WebhookEventType } from '@bge/webhooks';
import request from 'supertest';
import type { ApiKeyScope, Caller } from '../support/api-key';
import { mintApiKey } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
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
 * grants, which are not under test. The create cases give their keys the
 * event-type grant, so the only thing they turn on is the key's `manage`
 * scope (#1418).
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

  const createSubscription = (caller: Caller) =>
    request(baseUrl)
      .post(SUBSCRIPTIONS_PATH)
      .set(caller.headers)
      .send({
        url: 'https://hooks.example.com/created',
        resourceType: ResourceType.Event,
        eventTypes: [WebhookEventType.EventCreated],
      });

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
    // Made through this key, so the 403 below is the ceiling's and not the
    // rule that a key changes only its own subscriptions (#723).
    await db.client.webhookSubscription.updateMany({
      where: { id: { in: [scoped, other] } },
      data: { apiKeyId: key.id },
    });

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

  describe('creating a subscription (#1418)', () => {
    /** Lets a key receive the event type the create asks for, so the create turns on its `manage` scope alone. */
    const readPublicEvents: ApiKeyScope = { slugs: ['read:event:public'], resourceType: ResourceType.Event };

    it('refuses to create a subscription for a key whose manage scope is pinned to one subscription (#1418)', async () => {
      const { owner, scoped } = await arrange();
      const key = await mintApiKey(baseUrl, db.client, owner, [
        readPublicEvents,
        { slugs: ['read:webhook_subscription:own'], resourceType: ResourceType.WebhookSubscription },
        {
          slugs: ['manage:webhook_subscription:own'],
          resourceType: ResourceType.WebhookSubscription,
          resourceId: scoped,
        },
      ]);

      // The pin names a row that exists, never the one a create would write.
      const refused = await createSubscription(key).expect(403);
      expect(refused.body.message).toBe("You don't have permission to create webhook subscriptions");

      expect(await db.client.webhookSubscription.count({ where: { createdById: owner.user.id } })).toBe(2);
    });

    it('creates a subscription for a key whose manage scope names no subscription (#1418)', async () => {
      const { owner } = await arrange();
      const key = await mintApiKey(baseUrl, db.client, owner, [
        readPublicEvents,
        { slugs: ['manage:webhook_subscription:own'], resourceType: ResourceType.WebhookSubscription },
      ]);

      const created = subscriptionEnvelope(
        await createSubscription(key).expect(201),
        'POST /api/webhooks/subscriptions with an unpinned key',
      );
      expect(created.createdById).toBe(owner.user.id);
    });

    it("creates a subscription for its owner's session (#1418)", async () => {
      const { owner } = await arrange();

      subscriptionEnvelope(
        await createSubscription(owner).expect(201),
        'POST /api/webhooks/subscriptions as their owner',
      );
    });
  });
});
