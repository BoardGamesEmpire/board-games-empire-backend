import { EventSchedulingMode, GameAdditionMode, NominationStatus, OccurrenceStatus } from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { expectBackendsQueuedBehind, expectLockWaiter, withBarrier, type Barrier } from '../support/lock-barrier';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { arrangeListEntry } from './event-fixtures';
import { createEventClient, EVENTS_PATH } from './event-request';
import { nominationEnvelope } from './event-wire';

/**
 * Two status changes racing on one date or one nomination, the second queued
 * behind the first (#621).
 *
 * Each request reads the status and finds it allows the change before either
 * writes. The one that loses the race then answers 400, as a request arriving
 * after the first change would, and the row keeps the first change alone. A
 * date's confirm and decline read the status again under the event's row lock
 * (#795), and an approval under the nomination's (#551); a withdraw is the
 * last of them to do so.
 *
 * The barrier holds the row the first request locks, so it queues inside its
 * transaction. The second is fired and seen queued behind it, which means it
 * passed its own first check while the status still allowed it. Parallel
 * requests could never promise that interleaving, and would pass on the bug.
 */
describe('status changes racing on one date or nomination (#621)', () => {
  const baseUrl = requireBaseUrl(process.env);

  /** Generous for the reason `household-write-tombstone.spec.ts` gives: a cold request clears several guards first. */
  const REQUEST_REACHES_LOCK_MS = 20_000;

  const HOUR = 60 * 60 * 1000;
  const hoursFromNow = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

  /** The event's row, which a date's status change locks first (#795). */
  const EVENT_ROW = {
    sql: 'SELECT id FROM events WHERE id = $1 FOR NO KEY UPDATE',
    lockedBy: /FROM events WHERE id = \$1 FOR NO KEY UPDATE/,
  };

  /** The nomination's row, which an approval locks to check its status again (#551). */
  const NOMINATION_ROW = {
    sql: 'SELECT id FROM event_game_nominations WHERE id = $1 FOR UPDATE',
    lockedBy: /FROM event_game_nominations WHERE id = \$1 FOR UPDATE/,
  };

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const { createdEventId } = createEventClient(baseUrl);

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
   * Holds `row` by `id`, fires `first` and waits until it queues on that row,
   * then fires `second` and waits until both are queued. Returns both
   * statuses, in firing order.
   */
  const race = (
    row: { readonly sql: string; readonly lockedBy: RegExp },
    id: string,
    first: () => request.Test,
    second: () => request.Test,
  ) =>
    withBarrier(async (barrier) => {
      const { holder } = barrier;

      await holder.begin();
      await expect(holder.query(row.sql, [id])).resolves.toHaveLength(1);

      // Deliberately not awaited: it is supposed to be stuck.
      const firstRequest = fire(first);

      const waiting = await expectLockWaiter(barrier, {
        heldBy: holder.pid,
        description: 'the first status change',
        timeoutMs: REQUEST_REACHES_LOCK_MS,
        exclude: barrierPids(barrier),
        settledEarly: firstRequest.settledEarly,
      });
      expect(waiting.query).toMatch(row.lockedBy);

      const secondRequest = fire(second);

      await expectBackendsQueuedBehind(barrier, {
        heldBy: holder.pid,
        count: 2,
        description: 'the first status change, and the second behind it',
        timeoutMs: REQUEST_REACHES_LOCK_MS,
      });

      // Released before anything else is asked of the database: both
      // requests are inside interactive transactions on the default 5s
      // budget, and an expired budget surfaces as a 500.
      await holder.rollback();

      return [(await firstRequest.settled).status, (await secondRequest.settled).status];
    });

  describe("a date's confirm and decline", () => {
    const changeDate = (actor: AuthenticatedActor, eventId: string, occurrenceId: string, change: string) =>
      request(baseUrl).post(`${EVENTS_PATH}/${eventId}/occurrences/${occurrenceId}/${change}`).set(actor.headers);

    it('answers the second of a confirm and a decline 400, and leaves one timestamp', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host, {
        schedulingMode: EventSchedulingMode.Poll,
        occurrences: [{ startDate: hoursFromNow(24) }],
      });
      const [{ id: occurrenceId }] = await db.client.eventOccurrence.findMany({
        where: { eventId },
        select: { id: true },
      });

      const statuses = await race(
        EVENT_ROW,
        eventId,
        () => changeDate(host, eventId, occurrenceId, 'confirm'),
        () => changeDate(host, eventId, occurrenceId, 'decline'),
      );

      expect(statuses).toEqual([201, 400]);

      const date = await db.client.eventOccurrence.findUniqueOrThrow({
        where: { id: occurrenceId },
        select: { status: true, confirmedAt: true, declinedAt: true },
      });
      expect(date.status).toBe(OccurrenceStatus.Confirmed);
      expect(date.confirmedAt).not.toBeNull();
      expect(date.declinedAt).toBeNull();
    });
  });

  describe('a nomination awaiting the host', () => {
    /** An event whose host approves each game nominated, and the host's own nomination of a game for it. */
    const arrange = async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host, { policy: { gameAdditionMode: GameAdditionMode.HostApproval } });
      const entry = await arrangeListEntry(db.client, eventId, host.user.id);
      const nomination = nominationEnvelope(
        await request(baseUrl)
          .post(`${EVENTS_PATH}/${eventId}/nominations`)
          .set(host.headers)
          .send({ platformGameId: entry.platformGameId, suppliedFromId: entry.suppliedById })
          .expect(201),
        'POST /api/events/:eventId/nominations',
      );
      expect(nomination.status).toBe(NominationStatus.AwaitingApproval);

      return { host, eventId, nominationId: nomination.id };
    };

    const approve = (actor: AuthenticatedActor, eventId: string, nominationId: string) =>
      request(baseUrl).post(`${EVENTS_PATH}/${eventId}/nominations/${nominationId}/approve`).set(actor.headers);

    const withdraw = (actor: AuthenticatedActor, eventId: string, nominationId: string) =>
      request(baseUrl).patch(`${EVENTS_PATH}/${eventId}/nominations/${nominationId}/withdraw`).set(actor.headers);

    it('answers a withdraw queued behind an approval 400, and keeps the game in the lineup', async () => {
      const { host, eventId, nominationId } = await arrange();

      const statuses = await race(
        NOMINATION_ROW,
        nominationId,
        () => approve(host, eventId, nominationId),
        () => withdraw(host, eventId, nominationId),
      );

      expect(statuses).toEqual([201, 400]);
      expect(
        await db.client.eventGameNomination.findUniqueOrThrow({
          where: { id: nominationId },
          select: { status: true },
        }),
      ).toEqual({ status: NominationStatus.Approved });
      expect(await db.client.eventGame.count({ where: { nominationId } })).toBe(1);
    });

    it('adds the game once when two approvals race', async () => {
      const { host, eventId, nominationId } = await arrange();

      const statuses = await race(
        NOMINATION_ROW,
        nominationId,
        () => approve(host, eventId, nominationId),
        () => approve(host, eventId, nominationId),
      );

      // The second finds the nomination approved, rather than adding its game
      // to the lineup a second time.
      expect(statuses).toEqual([201, 400]);
      expect(await db.client.eventGame.count({ where: { nominationId } })).toBe(1);
      // Counted by event too: a second approval that did get through answered
      // 201, not the unique nomination's 500, so a count by nomination alone
      // need not see the game it added.
      expect(await db.client.eventGame.count({ where: { eventId } })).toBe(1);
    });
  });
});
