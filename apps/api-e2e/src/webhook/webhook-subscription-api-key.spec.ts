import { ResourceType, SystemRole } from '@bge/database';
import { WEBHOOK_QUEUE_NAME, type WebhookDeliveryJob } from '@bge/queue-webhooks';
import { createActors, type Actors, type AuthenticatedActor, type SessionActor } from '@bge/testing-e2e';
import { WebhookEventType } from '@bge/webhooks';
import request from 'supertest';
import { createMemberClient } from '../household/household-request';
import { mintApiKey, type ApiKeyScope, type Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { isolateQueue } from '../support/queue-isolation';
import { waitForStableJobCount } from '../support/queues';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { subscriptionEnvelope } from './webhook-wire';

const SUBSCRIPTIONS_PATH = '/api/webhooks/subscriptions';

/** Never contacted: the API runs no consumer, so nothing here is delivered. */
const RECEIVER_URL = 'https://receiver.e2e.invalid/bge';

/** The refusal of a key's write to a webhook subscription it didn't make, not a ceiling's. */
const OTHER_KEY_REFUSAL = 'This API key can change only the webhook subscriptions it made';

/** The refusal of a check that the key a webhook subscription was made through can't pass. */
const UNUSABLE_KEY_REFUSAL =
  "This webhook subscription was made through an API key that is deleted, disabled or expired, so it can't receive events";

/**
 * A webhook subscription made through an API key, over the real routes
 * (#723). The webhook subscription records the key, and a write through a key
 * reaches only that key's own webhook subscriptions, so the reach one was made
 * with never changes after it is made. Dispatch then holds it to the key's
 * scope as well as its creator's, and stops it once the key stops.
 */
describe('webhook subscriptions made through an API key (#723)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const { transferOwnership } = createMemberClient(baseUrl);

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

  const subscribe = async (caller: Caller, resourceId?: string): Promise<string> => {
    const response = await request(baseUrl)
      .post(SUBSCRIPTIONS_PATH)
      .set(caller.headers)
      .send({
        url: RECEIVER_URL,
        resourceType: ResourceType.Household,
        resourceId,
        eventTypes: [WebhookEventType.HouseholdOwnershipTransferred],
      })
      .expect(201);

    return subscriptionEnvelope(response, `POST ${SUBSCRIPTIONS_PATH}`).id;
  };

  const move = (caller: Caller, id: string, url: string) =>
    request(baseUrl).patch(`${SUBSCRIPTIONS_PATH}/${id}`).set(caller.headers).send({ url });

  const reactivate = (caller: Caller, id: string) =>
    request(baseUrl).post(`${SUBSCRIPTIONS_PATH}/${id}/reactivate`).set(caller.headers);

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

    // Dispatch delivers nothing through a deleted key, so a 200 here would
    // promise deliveries that never come.
    it('refuses the key owner’s session a reactivation once the key is deleted', async () => {
      const owner = await actors.user();
      const key = await keyOf(owner);
      const subscriptionId = await subscribe(key);

      // The control: while the key lasts, the key owner's session reactivates it.
      await reactivate(owner, subscriptionId).expect(201);

      await db.client.apikey.delete({ where: { id: key.id } });
      const refused = await reactivate(owner, subscriptionId).expect(409);
      expect(refused.body.message).toBe(UNUSABLE_KEY_REFUSAL);
    });
  });

  /**
   * The API runs the dispatcher and no consumer, so each delivery waits in the
   * queue, and a job is the dispatcher's whole verdict (see
   * `webhook-dispatch.spec.ts`).
   */
  describe('dispatch', () => {
    const webhookQueue = isolateQueue(WEBHOOK_QUEUE_NAME);

    /** Each waiting delivery, once the count has held at `count`. */
    const deliveries = async (count: number) => {
      await waitForStableJobCount(webhookQueue(), count);
      const jobs = await webhookQueue().getJobs(['waiting']);

      return jobs
        .map(({ data }) => data as WebhookDeliveryJob)
        .map(({ subscriptionId, subjectId }) => ({ subscriptionId, subjectId }));
    };

    interface Household {
      readonly id: string;
      readonly owner: AuthenticatedActor;
      readonly heir: AuthenticatedActor;
      readonly heirMemberId: string;
    }

    /**
     * The key's owner is a plain member of two households, each owned by
     * someone about to hand it to an heir. Their key reads only the first. The
     * rosters are written before anyone makes a request, so no cached graph
     * misses them.
     */
    const arrange = async () => {
      const keyOwner = await actors.user();
      const household = async (): Promise<Household> => {
        const owner = await actors.user();
        const heir = await actors.user();
        const fixture = await actors.householdWithMembers({
          owner,
          members: [
            { actor: heir, role: SystemRole.HouseholdMember },
            { actor: keyOwner, role: SystemRole.HouseholdMember },
          ],
        });

        return { id: fixture.household.id, owner, heir, heirMemberId: fixture.members[0].member.id };
      };
      const reached = await household();
      const unreached = await household();

      const key = await mintApiKey(
        baseUrl,
        db.client,
        keyOwner,
        subscribingScope({ slugs: ['read:households'], resourceType: ResourceType.Household, resourceId: reached.id }),
      );
      // Every household, as far as the webhook subscription itself says.
      const keySubscription = await subscribe(key);

      return {
        key,
        keySubscription,
        reached,
        unreached,
        // The heir's own webhook subscription to their household: it receives, which
        // shows dispatch ran for that household's event.
        watch: (of: Household) => subscribe(of.heir, of.id),
        transfer: (of: Household) => transferOwnership(of.owner, of.id, of.heirMemberId).expect(200),
      };
    };

    const bySubscription = <T extends { subscriptionId: string }>(a: T, b: T) =>
      a.subscriptionId.localeCompare(b.subscriptionId);

    it('delivers only the events its key can reach', async () => {
      const { keySubscription, reached, unreached, watch, transfer } = await arrange();
      const control = await watch(unreached);

      await transfer(reached);
      await transfer(unreached);

      expect((await deliveries(2)).sort(bySubscription)).toEqual(
        [
          { subscriptionId: keySubscription, subjectId: reached.id },
          { subscriptionId: control, subjectId: unreached.id },
        ].sort(bySubscription),
      );
    });

    const keyStates: [string, (keyId: string) => Promise<unknown>][] = [
      ['disabled', (id) => db.client.apikey.update({ where: { id }, data: { enabled: false } })],
      [
        'expired',
        (id) => db.client.apikey.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 60_000) } }),
      ],
      ['deleted', (id) => db.client.apikey.delete({ where: { id } })],
    ];

    it.each(keyStates)('delivers nothing once its key is %s', async (_state, change) => {
      const { key, reached, watch, transfer } = await arrange();
      const control = await watch(reached);

      await change(key.id);
      await transfer(reached);

      expect(await deliveries(1)).toEqual([{ subscriptionId: control, subjectId: reached.id }]);
    });
  });
});
