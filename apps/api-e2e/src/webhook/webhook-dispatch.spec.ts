import { ResourceType, SystemRole } from '@bge/database';
import { PermissionsService } from '@bge/permissions';
import { WEBHOOK_QUEUE_NAME, type WebhookDeliveryJob } from '@bge/queue-webhooks';
import { createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import { WebhookEventType } from '@bge/webhooks';
import request from 'supertest';
import { createEventClient, EVENTS_PATH } from '../event/event-request';
import { createMemberClient } from '../household/household-request';
import { apiCacheHas } from '../support/api-cache';
import { requireBaseUrl } from '../support/e2e-env';
import { isolateQueue } from '../support/queue-isolation';
import { waitForStableJobCount } from '../support/queues';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { subscriptionEnvelope } from './webhook-wire';

const SUBSCRIPTIONS_PATH = '/api/webhooks/subscriptions';

/** Never contacted: the API runs no consumer, so nothing here is delivered. */
const RECEIVER_URL = 'https://receiver.e2e.invalid/bge';

/**
 * The API's webhook emit sites, driven through their real routes to an
 * enqueued delivery (#538).
 *
 * The API runs the dispatcher and no consumer (see `support/queues.ts`), so
 * each delivery sits in the webhook queue as a waiting job. A job is the
 * dispatcher's whole verdict: the subscription matched, and its creator passed
 * the visibility check at dispatch.
 *
 * Each test arranges one subscription that should receive, so a count of one
 * shows the dispatcher ran, and the job's subscription id shows which one it
 * picked. Where a subscriber must NOT receive, a reader subscribes beside them:
 * zero jobs alone would also be what a process with no dispatcher produces.
 *
 * The worker processes' emit sites are #611's to drive, since only an import
 * across processes reaches them.
 */
describe('webhook dispatch from the API (#538)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const events = createEventClient(baseUrl);
  const { transferOwnership } = createMemberClient(baseUrl);

  let db: TestDatabase;
  let actors: Actors;

  const webhookQueue = isolateQueue(WEBHOOK_QUEUE_NAME);

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const subscribe = async (actor: AuthenticatedActor, body: Record<string, unknown>): Promise<string> => {
    const response = await request(baseUrl)
      .post(SUBSCRIPTIONS_PATH)
      .set(actor.headers)
      .send({ url: RECEIVER_URL, ...body })
      .expect(201);

    return subscriptionEnvelope(response, `POST ${SUBSCRIPTIONS_PATH}`).id;
  };

  /** The one waiting delivery, once the count has held at one. */
  const onlyDelivery = async (): Promise<{ id: string | undefined; data: WebhookDeliveryJob }> => {
    await waitForStableJobCount(webhookQueue(), 1);
    const [job] = await webhookQueue().getJobs(['waiting']);

    if (job === undefined) {
      throw new Error('The webhook queue held one pending job, but none of it is waiting');
    }

    return { id: job.id, data: job.data as WebhookDeliveryJob };
  };

  /**
   * A household whose owner is about to hand it to the heir, with a watcher
   * who is a member too. Arranged before any of them makes a request: the
   * fixture writes the roster directly, and a graph a request cached earlier
   * would not see it, so the owner's transfer would be refused (#538).
   */
  const householdToTransfer = async () => {
    const owner = await actors.user();
    const heir = await actors.user();
    const watcher = await actors.user();
    const fixture = await actors.householdWithMembers({
      owner,
      members: [
        { actor: heir, role: SystemRole.HouseholdMember },
        { actor: watcher, role: SystemRole.HouseholdMember },
      ],
    });
    const householdId = fixture.household.id;
    const [heirMember] = fixture.members;

    return {
      owner,
      heir,
      watcher,
      householdId,
      subscribeToTransfers: (actor: AuthenticatedActor) =>
        subscribe(actor, {
          resourceType: ResourceType.Household,
          resourceId: householdId,
          eventTypes: [WebhookEventType.HouseholdOwnershipTransferred],
        }),
      transfer: () => transferOwnership(owner, householdId, heirMember.member.id).expect(200),
    };
  };

  it('enqueues a delivery when a household changes owners', async () => {
    const { owner, heir, watcher, householdId, subscribeToTransfers, transfer } = await householdToTransfer();
    const subscriptionId = await subscribeToTransfers(watcher);

    await transfer();

    const delivery = await onlyDelivery();

    expect(delivery.data).toMatchObject({
      subscriptionId,
      eventType: WebhookEventType.HouseholdOwnershipTransferred,
      subjectId: householdId,
      payload: { data: { householdId, newOwnerUserId: heir.user.id, previousOwnerUserId: owner.user.id } },
    });
  });

  it('enqueues a delivery for a subscriber whose only read arrived after their graph was cached (#732)', async () => {
    const owner = await actors.user();
    const watcher = await actors.user();
    // The request caches the watcher's graph, holding no membership.
    const subscriptionId = await subscribe(watcher, {
      resourceType: ResourceType.Event,
      eventTypes: [WebhookEventType.EventCreated],
    });
    expect(await apiCacheHas(PermissionsService.userGraphCacheKey(watcher.user.id))).toBe(true);

    // The fixture writes the roster directly and creating the event evicts
    // only its creator's graph, so nothing evicts the watcher's. A member
    // reads a household's events only through the membership their graph
    // carries: the household read itself is matched against live rows, and
    // would pass with the cached graph too.
    const fixture = await actors.householdWithMembers({
      owner,
      members: [{ actor: watcher, role: SystemRole.HouseholdMember }],
    });
    const eventId = await events.createdEventId(owner, { householdId: fixture.household.id });

    expect((await onlyDelivery()).data).toMatchObject({ subscriptionId, subjectId: eventId });
  });

  it('enqueues nothing for a subscriber banned since subscribing, beside one who is not (#906)', async () => {
    const { heir, watcher, subscribeToTransfers, transfer } = await householdToTransfer();
    const heirSubscriptionId = await subscribeToTransfers(heir);
    await subscribeToTransfers(watcher);

    // A ban changes no role, so nothing evicts the watcher's graph: the one
    // cached when they subscribed still holds their membership.
    await db.client.user.update({ where: { id: watcher.user.id }, data: { banned: true } });
    await transfer();

    await waitForStableJobCount(webhookQueue(), 1);
    const waiting = await webhookQueue().getJobs(['waiting']);

    expect(waiting.map((job) => (job.data as WebhookDeliveryJob).subscriptionId)).toEqual([heirSubscriptionId]);
  });

  it('enqueues a delivery to a subscriber whose ban has expired (#906)', async () => {
    const { watcher, householdId, subscribeToTransfers, transfer } = await householdToTransfer();
    const subscriptionId = await subscribeToTransfers(watcher);

    await db.client.user.update({
      where: { id: watcher.user.id },
      data: { banned: true, banExpires: new Date(Date.now() - 60_000) },
    });
    await transfer();

    expect((await onlyDelivery()).data).toMatchObject({ subscriptionId, subjectId: householdId });
  });

  it('enqueues a delivery when an event is created, for its creator', async () => {
    // Outside a household the creator reads the event through their host role
    // alone, which their graph holds only once the event exists. A dispatch
    // that read the graph this request cached before the event would refuse
    // them unless createEvent had evicted it first (#732).
    const host = await actors.user();
    const subscriptionId = await subscribe(host, {
      resourceType: ResourceType.Event,
      eventTypes: [WebhookEventType.EventCreated],
    });

    const eventId = await events.createdEventId(host);
    const delivery = await onlyDelivery();

    expect(delivery.data).toMatchObject({
      subscriptionId,
      eventType: WebhookEventType.EventCreated,
      subjectId: eventId,
      payload: { data: { eventId, householdId: null } },
    });
    // Keyed on the event, so a re-emit of the same creation dedups to one job
    // while the first is still queued.
    expect(delivery.id).toBe(`${WebhookEventType.EventCreated}:${subscriptionId}:${eventId}`);
  });

  it('enqueues a delivery when an event is updated, naming the changed columns only', async () => {
    const host = await actors.user();
    const eventId = await events.createdEventId(host);
    const subscriptionId = await subscribe(host, {
      resourceType: ResourceType.Event,
      resourceId: eventId,
      eventTypes: [WebhookEventType.EventUpdated],
    });

    await request(baseUrl)
      .patch(`${EVENTS_PATH}/${eventId}`)
      .set(host.headers)
      .send({ title: 'Renamed for the webhook', location: '12 Home Street' })
      .expect(200);

    const delivery = await onlyDelivery();

    expect(delivery.data).toMatchObject({
      subscriptionId,
      eventType: WebhookEventType.EventUpdated,
      subjectId: eventId,
    });
    expect(delivery.data.payload.data).toEqual({
      eventId,
      householdId: null,
      changedFields: ['title', 'location'],
    });
  });

  it('enqueues a delivery to an attendee when an event is deleted', async () => {
    // The emit follows the soft delete, so this is the case that needs the
    // deleted row checked: a live-row check refuses every subscriber.
    const host = await actors.user();
    const guest = await actors.user();
    const eventId = await events.createdEventId(host, { inviteUserIds: [guest.user.id] });
    const subscriptionId = await subscribe(guest, {
      resourceType: ResourceType.Event,
      resourceId: eventId,
      eventTypes: [WebhookEventType.EventDeleted],
    });

    await request(baseUrl).delete(`${EVENTS_PATH}/${eventId}`).set(host.headers).expect(200);

    const delivery = await onlyDelivery();

    expect(delivery.data).toMatchObject({
      subscriptionId,
      eventType: WebhookEventType.EventDeleted,
      subjectId: eventId,
      payload: { data: { eventId, householdId: null } },
    });
  });

  it('enqueues nothing for a subscriber who cannot read the event', async () => {
    // A stranger may subscribe to every event they can read, and this one is
    // not theirs to read: it is Friends-visible and they are no friend of its
    // host. The host's own subscription is the control that shows the
    // dispatcher ran.
    const host = await actors.user();
    const stranger = await actors.user();
    await subscribe(stranger, {
      resourceType: ResourceType.Event,
      eventTypes: [WebhookEventType.EventCreated],
    });
    const hostSubscriptionId = await subscribe(host, {
      resourceType: ResourceType.Event,
      eventTypes: [WebhookEventType.EventCreated],
    });

    await events.createdEventId(host);
    await waitForStableJobCount(webhookQueue(), 1);
    const waiting = await webhookQueue().getJobs(['waiting']);

    // Both subscriptions match the event, so the stranger's absence from this
    // list is the visibility check's refusal.
    expect(waiting.map((job) => (job.data as WebhookDeliveryJob).subscriptionId)).toEqual([hostSubscriptionId]);
  });
});
