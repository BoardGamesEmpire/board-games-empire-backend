import { QuotaScope, ResourceType } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { WebhookEventType } from '@bge/webhooks';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { expectLockWaiter, withBarrier, type Barrier } from '../support/lock-barrier';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { SOFT_DELETE_HOUSEHOLD } from './lock-fixtures';

/**
 * #552's acceptance over HTTP: writes outside the household lib that add state
 * to a household, racing a soft-delete that commits first.
 *
 * Both check the household before their transaction without a lock, so a delete
 * committing in between used to leave a webhook subscription, or a quota, on a
 * household the API treats as gone. Each now takes the household's share lock
 * first in its transaction, which is what these cases drive.
 *
 * The barrier holds a real soft-delete open. Every read in front of the lock is
 * a plain MVCC read, so it sees the household live and does not wait; the
 * request reaches its transaction and queues on the household row.
 * `expectLockWaiter` proves it queued there, and the running statement proves
 * which lock it queued on. Then the delete commits, and the request must be
 * refused with nothing written.
 *
 * Refused with 403, not 404. Neither route is a household route, and each
 * answers a household that is already gone with 403 from its own check (quota
 * deliberately, so the endpoint is no existence oracle). A request that loses
 * the race gets the same answer as one that arrives just after it (#288).
 *
 * Same harness as `role-transition-tombstone.spec.ts`; the plugin writes are
 * `plugin/plugin-household-tombstone.spec.ts`.
 */
describe('household-bound writes racing a soft-delete (#552)', () => {
  const baseUrl = requireBaseUrl(process.env);

  /** Generous for the reason `plugin-prerow-race.spec.ts` gives: a cold request clears several guards first. */
  const REQUEST_REACHES_LOCK_MS = 20_000;

  /** Never contacted: the API runs no webhook consumer. */
  const RECEIVER_URL = 'https://receiver.e2e.invalid/bge';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  interface Arrangement {
    readonly householdId: string;
    readonly owner: SessionActor;
    readonly admin: SessionActor;
  }

  const arrange = async (): Promise<Arrangement> => {
    const owner = await actors.user();
    const admin = await actors.admin();
    const { household } = await actors.householdWithMembers({ owner, name: 'Deleted while a write waits' });

    return { householdId: household.id, owner, admin };
  };

  /**
   * Each write, sent by an actor it would succeed for on a live household. That
   * is what makes the refusal mean the lock refused it.
   */
  const WRITES: readonly {
    readonly name: string;
    readonly send: (a: Arrangement) => request.Test;
    readonly written: (a: Arrangement) => Promise<number>;
  }[] = [
    {
      name: 'webhook subscription create',
      send: ({ householdId, owner }) =>
        request(baseUrl)
          .post('/api/webhooks/subscriptions')
          .set(owner.headers)
          .send({
            url: RECEIVER_URL,
            resourceType: ResourceType.Household,
            eventTypes: [WebhookEventType.HouseholdOwnershipTransferred],
            householdId,
          }),
      written: ({ householdId }) => db.client.webhookSubscription.count({ where: { householdId } }),
    },
    {
      name: 'household quota',
      send: ({ householdId, admin }) =>
        request(baseUrl)
          .patch(`/api/quotas/${QuotaScope.Household}/${householdId}/household_member_count`)
          .set(admin.headers)
          .send({ limit: '5' }),
      written: ({ householdId }) =>
        db.client.quota.count({ where: { scope: QuotaScope.Household, scopeId: householdId } }),
    },
  ];

  /** The barrier's own backends, which are never the request under test. */
  const barrierPids = (barrier: Barrier): number[] => [barrier.waiter.pid, barrier.observer.pid];

  /**
   * Fires a request that is expected to BLOCK, and keeps hold of it safely. Same
   * shape as the helper in `plugin-prerow-race.spec.ts`.
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

  it.each(WRITES)('refuses a $name that queued behind the soft-delete, with nothing written', async (write) => {
    const arrangement = await arrange();

    const response = await withBarrier(async (barrier) => {
      const { holder } = barrier;

      await holder.begin();
      await expect(holder.query(SOFT_DELETE_HOUSEHOLD, [arrangement.householdId])).resolves.toHaveLength(1);

      // Deliberately not awaited: it is supposed to be stuck.
      const pending = fire(() => write.send(arrangement));

      const waiter = await expectLockWaiter(barrier, {
        heldBy: holder.pid,
        description: `the ${write.name} request`,
        timeoutMs: REQUEST_REACHES_LOCK_MS,
        exclude: barrierPids(barrier),
        settledEarly: pending.settledEarly,
      });

      // Queued on the household's share lock specifically, the statement whose
      // re-check this suite is about.
      expect(waiter.query).toMatch(/FROM households h[\s\S]*FOR SHARE/);

      // Released before anything else is asked of the database: the request is
      // inside an interactive transaction on the default 5s budget, and an
      // expired budget surfaces as a 500 that reads as a lock failure.
      await holder.commit();

      return pending.settled;
    });

    expect(response.status).toBe(403);
    await expect(write.written(arrangement)).resolves.toBe(0);
  });
});
