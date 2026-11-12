import { QuotaScope, ResourceType, WebhookSubscriptionStatus } from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor, type SessionActor } from '@bge/testing-e2e';
import { WebhookEventType } from '@bge/webhooks';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { subscriptionEnvelope } from './webhook-wire';

const RESOURCE = 'webhook_subscription_count';
const SUBSCRIPTIONS_PATH = '/api/webhooks/subscriptions';

/** Never contacted: the API runs no consumer, so nothing here is delivered. */
const RECEIVER_URL = 'https://receiver.e2e.invalid/bge';

/**
 * How many live webhook subscriptions a user may have (#1253): a quota
 * resource counting, at `User` scope, the subscriptions a user created that
 * are not deleted. Past a hard quota the create answers 402. No row means no
 * quota.
 *
 * Each test gives its own user a quota of their own. A default quota would
 * limit every other suite's subscribers as well.
 */
describe('webhook subscription quota (#1253)', () => {
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

  /** Ownership transfers of a household the owner reads, which any owner may subscribe to. */
  const createSubscription = (actor: AuthenticatedActor, householdId: string) =>
    request(baseUrl)
      .post(SUBSCRIPTIONS_PATH)
      .set(actor.headers)
      .send({
        url: RECEIVER_URL,
        resourceType: ResourceType.Household,
        resourceId: householdId,
        eventTypes: [WebhookEventType.HouseholdOwnershipTransferred],
      });

  const subscribe = async (actor: AuthenticatedActor, householdId: string): Promise<string> =>
    subscriptionEnvelope(await createSubscription(actor, householdId).expect(201), `POST ${SUBSCRIPTIONS_PATH}`).id;

  /** A hard quota of `limit` live webhook subscriptions for one user. */
  const setQuota = (userId: string, limit: number) =>
    db.client.quota.create({
      data: { scope: QuotaScope.User, scopeId: userId, resource: RESOURCE, limit: BigInt(limit) },
    });

  const liveOf = (owner: SessionActor) =>
    db.client.webhookSubscription.findMany({
      where: { createdById: owner.user.id, deletedAt: null },
      select: { id: true, status: true },
    });

  const ownedHousehold = async () => {
    const owner = await actors.user();
    const { household } = await actors.householdWithMembers({ owner });

    return { owner, householdId: household.id };
  };

  it('refuses a user past their quota with 402, naming it, and leaves the first subscription alone', async () => {
    const { owner, householdId } = await ownedHousehold();
    await setQuota(owner.user.id, 1);

    const first = await subscribe(owner, householdId);
    const refused = await createSubscription(owner, householdId).expect(402);

    expect(refused.body).toMatchObject({
      resource: RESOURCE,
      scope: QuotaScope.User,
      limit: '1',
      currentUsage: '1',
      attemptedAmount: '1',
    });
    expect(await liveOf(owner)).toEqual([{ id: first, status: WebhookSubscriptionStatus.Active }]);
  });

  it('frees a place when a subscription is deleted', async () => {
    const { owner, householdId } = await ownedHousehold();
    await setQuota(owner.user.id, 1);

    const first = await subscribe(owner, householdId);
    // Full before the delete, so the 201 after it is the place the delete freed.
    await createSubscription(owner, householdId).expect(402);
    await request(baseUrl).delete(`${SUBSCRIPTIONS_PATH}/${first}`).set(owner.headers).expect(200);

    await subscribe(owner, householdId);
  });

  it('limits nobody without a quota', async () => {
    const { owner, householdId } = await ownedHousehold();

    for (let made = 0; made < 3; made++) {
      await subscribe(owner, householdId);
    }

    expect(await liveOf(owner)).toHaveLength(3);
  });
});
