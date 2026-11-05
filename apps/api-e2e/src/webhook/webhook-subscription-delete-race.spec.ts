import { ResourceType } from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import { WebhookEventType } from '@bge/webhooks';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { expectBackendsQueuedBehind, expectLockWaiter, withBarrier, type Barrier } from '../support/lock-barrier';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * Two writes to one webhook subscription, the second queued behind a delete
 * (#767).
 *
 * Each write first reads the webhook subscription through the request's own
 * check, and both find it live before either writes. Until #767 the second
 * then wrote anyway: a second DELETE answered 200, and a PATCH behind a
 * DELETE changed the deleted webhook subscription's URL. A write that loses
 * the race to a delete now answers 404, as a request arriving after the
 * delete would.
 *
 * Nothing in the API locks a webhook subscription's row. The barrier holds
 * it here only so both requests pass their check before either writes; each
 * request then queues on its own UPDATE. Parallel requests could never
 * promise that interleaving, and would pass on the bug.
 *
 * The webhook subscription is arranged directly: creating one checks
 * event-type grants, which are not under test.
 */
describe('two writes racing one webhook subscription (#767)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const SUBSCRIPTIONS_PATH = '/api/webhooks/subscriptions';
  const SEEDED_URL = 'https://hooks.example.com/seeded';

  /** Generous for the reason `household-write-tombstone.spec.ts` gives: a cold request clears several guards first. */
  const REQUEST_REACHES_LOCK_MS = 20_000;

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const deleteSubscription = (actor: AuthenticatedActor, id: string) =>
    request(baseUrl).delete(`${SUBSCRIPTIONS_PATH}/${id}`).set(actor.headers);

  const moveSubscription = (actor: AuthenticatedActor, id: string, url: string) =>
    request(baseUrl).patch(`${SUBSCRIPTIONS_PATH}/${id}`).set(actor.headers).send({ url });

  const retypeSubscription = (actor: AuthenticatedActor, id: string, eventTypes: WebhookEventType[]) =>
    request(baseUrl).patch(`${SUBSCRIPTIONS_PATH}/${id}`).set(actor.headers).send({ eventTypes });

  /** An owner and one live webhook subscription of theirs. */
  const arrange = async () => {
    const owner = await actors.user();
    const { id } = await db.client.webhookSubscription.create({
      data: {
        url: SEEDED_URL,
        secret: 'stored-ciphertext-never-read',
        resourceType: ResourceType.Event,
        createdById: owner.user.id,
        eventTypes: { create: [{ eventType: WebhookEventType.EventCreated }] },
      },
      select: { id: true },
    });

    return { owner, id };
  };

  /** The barrier's own backends, which are never the request under test. */
  const barrierPids = (barrier: Barrier): number[] => [barrier.waiter.pid, barrier.observer.pid];

  /**
   * Fires a request that is expected to block, and keeps hold of it
   * safely. Same shape as the helper in `event-occurrences.spec.ts`.
   */
  const fire = (send: () => request.Test) => {
    let outcome: string | undefined;
    const settled = send().then(
      (response) => {
        outcome = `HTTP ${response.status}`;

        return response;
      },
      (error: unknown) => {
        outcome = `it failed: ${error instanceof Error ? error.message : String(error)}`;
        throw error;
      },
    );

    settled.catch(() => undefined);

    return { settled, settledEarly: () => outcome };
  };

  /**
   * Holds the webhook subscription's row, fires `first` and waits until it
   * queues behind the barrier, then fires `second` and waits until both are
   * queued.
   * Returns both responses, in firing order.
   */
  const race = (id: string, first: () => request.Test, second: () => request.Test) =>
    withBarrier(async (barrier) => {
      const { holder } = barrier;

      await holder.begin();
      await expect(
        holder.query('SELECT id FROM webhook_subscriptions WHERE id = $1 FOR UPDATE', [id]),
      ).resolves.toHaveLength(1);

      // Deliberately not awaited: it is supposed to be stuck.
      const firstRequest = fire(first);

      await expectLockWaiter(barrier, {
        heldBy: holder.pid,
        description: 'the first write to the webhook subscription',
        timeoutMs: REQUEST_REACHES_LOCK_MS,
        exclude: barrierPids(barrier),
        settledEarly: firstRequest.settledEarly,
      });

      const secondRequest = fire(second);

      await expectBackendsQueuedBehind(barrier, {
        heldBy: holder.pid,
        count: 2,
        description: 'the first write, and the second behind it',
        timeoutMs: REQUEST_REACHES_LOCK_MS,
      });

      // Released before anything else is asked of the database, as the
      // other barrier specs do.
      await holder.rollback();

      return [await firstRequest.settled, await secondRequest.settled] as const;
    });

  it('answers the second of two DELETEs 404', async () => {
    const { owner, id } = await arrange();

    const [first, second] = await race(
      id,
      () => deleteSubscription(owner, id),
      () => deleteSubscription(owner, id),
    );

    expect([first.status, second.status]).toEqual([200, 404]);
    expect(second.body.message).toBe(`Webhook subscription ${id} not found`);
  });

  it('answers a PATCH queued behind a DELETE 404, and leaves the URL as it was', async () => {
    const { owner, id } = await arrange();

    const [first, second] = await race(
      id,
      () => deleteSubscription(owner, id),
      () => moveSubscription(owner, id, 'https://hooks.example.com/late'),
    );

    expect([first.status, second.status]).toEqual([200, 404]);

    const row = await db.client.webhookSubscription.findUniqueOrThrow({
      where: { id },
      select: { url: true, deletedAt: true },
    });
    expect(row.url).toBe(SEEDED_URL);
    expect(row.deletedAt).not.toBeNull();
  });

  it('answers a PATCH of the event types queued behind a DELETE 404, and leaves the event types as they were', async () => {
    const { owner, id } = await arrange();

    const [first, second] = await race(
      id,
      () => deleteSubscription(owner, id),
      () => retypeSubscription(owner, id, [WebhookEventType.EventUpdated]),
    );

    expect([first.status, second.status]).toEqual([200, 404]);

    const eventTypes = await db.client.webhookSubscriptionEventType.findMany({
      where: { subscriptionId: id },
      select: { eventType: true },
    });
    expect(eventTypes).toEqual([{ eventType: WebhookEventType.EventCreated }]);
  });
});
