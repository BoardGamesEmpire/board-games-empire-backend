import { EventParticipationStatus, NominationStatus, OccurrenceStatus, VoteType } from '@bge/database';
import type { Actors, AuthenticatedActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import type { Barrier } from '../support/lock-barrier';
import { expectBackendsQueuedBehind, expectLockWaiter, withBarrier } from '../support/lock-barrier';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { auditRowsDuring } from './event-audit';
import { arrangeListEntry } from './event-fixtures';
import { createEventClient, EVENTS_PATH } from './event-request';
import { eventGameEnvelope } from './event-wire';

/**
 * Two writes to one event, the second queued behind a delete (#731).
 *
 * Both requests read the event live before either writes. Until #731 the
 * second then wrote over the first: a second DELETE answered 200 and recorded
 * a second delete under its own name, and a PATCH behind a DELETE edited the
 * deleted event. A request that loses the race to a delete now answers 404, as
 * one arriving after the delete would.
 *
 * The barrier holds the event's row, so the first request queues inside its
 * transaction. The second is fired and seen queued behind it, which means it
 * passed every check in front of the lock while the event was still live.
 * Parallel requests could never promise that interleaving, and would pass on
 * the bug.
 *
 * The writes beneath the event race its delete the same way (#1065): each
 * takes the event's row before it writes, and reads the event under it.
 */
describe('two writes racing one event (#731)', () => {
  const baseUrl = requireBaseUrl(process.env);

  /** Generous for the reason `household-write-tombstone.spec.ts` gives: a cold request clears several guards first. */
  const REQUEST_REACHES_LOCK_MS = 20_000;

  /** How long the audit listener may take to write its row after the request has answered. */
  const AUDIT_ROW_LANDS_MS = 5_000;

  /**
   * The `event` column of the audit row a delete produces. Inlined rather than
   * imported from the event lib: this suite asserts only what the server wrote.
   */
  const EVENT_DELETED = 'event.event.deleted';

  /** The statement each request queues on once the event lib locks the event's row first. */
  const LOCKS_THE_EVENT = /FROM events WHERE id = \$1 FOR NO KEY UPDATE/;

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

  const deleteEvent = (actor: AuthenticatedActor, eventId: string) =>
    request(baseUrl).delete(`${EVENTS_PATH}/${eventId}`).set(actor.headers);

  const updateEvent = (actor: AuthenticatedActor, eventId: string, body: Record<string, unknown>) =>
    request(baseUrl).patch(`${EVENTS_PATH}/${eventId}`).set(actor.headers).send(body);

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
   * Holds the event's row, fires `first` and waits until it queues behind the
   * barrier, then fires `second` and waits until both are queued. Returns both
   * answers, in firing order, and the statements the two queued on.
   */
  const race = (eventId: string, first: () => request.Test, second: () => request.Test) =>
    withBarrier(async (barrier) => {
      const { holder } = barrier;

      await holder.begin();
      await expect(
        holder.query('SELECT id FROM events WHERE id = $1 FOR NO KEY UPDATE', [eventId]),
      ).resolves.toHaveLength(1);

      // Deliberately not awaited: it is supposed to be stuck.
      const firstRequest = fire(first);

      await expectLockWaiter(barrier, {
        heldBy: holder.pid,
        description: 'the first write to the event',
        timeoutMs: REQUEST_REACHES_LOCK_MS,
        exclude: barrierPids(barrier),
        settledEarly: firstRequest.settledEarly,
      });

      const secondRequest = fire(second);

      const queued = await expectBackendsQueuedBehind(barrier, {
        heldBy: holder.pid,
        count: 2,
        description: 'the first write, and the second behind it',
        timeoutMs: REQUEST_REACHES_LOCK_MS,
      });

      // Released before anything else is asked of the database: both
      // requests are inside interactive transactions on the default 5s
      // budget, and an expired budget surfaces as a 500.
      await holder.rollback();

      return {
        statuses: [(await firstRequest.settled).status, (await secondRequest.settled).status],
        queuedOn: queued.map(({ query }) => query),
      };
    });

  it('answers the second of two DELETEs 404, and records one delete by the first', async () => {
    const host = await actors.user();
    const moderator = await actors.moderator();
    const eventId = await createdEventId(host);

    const { statuses, queuedOn } = await race(
      eventId,
      () => deleteEvent(host, eventId),
      () => deleteEvent(moderator, eventId),
    );

    expect(statuses).toEqual([200, 404]);
    expect(await db.client.event.findUniqueOrThrow({ where: { id: eventId }, select: { deletedById: true } })).toEqual({
      deletedById: host.user.id,
    });

    // The absence of a second audit row is only worth asserting once this
    // harness is shown to record a delete at all, so a delete of a second
    // event runs after the race and its row is awaited first. Both raced
    // requests had answered by then, so any row they caused was written too.
    const sentinelId = await createdEventId(host);
    await deleteEvent(host, sentinelId).expect(200);

    const deletesRecordedFor = (id: string): Promise<number> =>
      db.client.auditLog.count({ where: { event: EVENT_DELETED, subjectId: id } });

    const deadline = Date.now() + AUDIT_ROW_LANDS_MS;
    while ((await deletesRecordedFor(sentinelId)) === 0 && Date.now() < deadline) {
      await sleep(50);
    }

    await expect(deletesRecordedFor(sentinelId)).resolves.toBe(1);
    await expect(deletesRecordedFor(eventId)).resolves.toBe(1);

    // Last, so a run against a lib that doesn't lock first fails on the
    // outcome above rather than here.
    expect(queuedOn).toEqual([expect.stringMatching(LOCKS_THE_EVENT), expect.stringMatching(LOCKS_THE_EVENT)]);
  });

  it('answers a PATCH queued behind a DELETE 404, and writes nothing to the deleted event', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host, { title: 'Before the race' });

    const { statuses, queuedOn } = await race(
      eventId,
      () => deleteEvent(host, eventId),
      () => updateEvent(host, eventId, { title: 'Too late' }),
    );

    expect(statuses).toEqual([200, 404]);

    const row = await db.client.event.findUniqueOrThrow({
      where: { id: eventId },
      select: { title: true, deletedAt: true },
    });
    expect(row.title).toBe('Before the race');
    expect(row.deletedAt).not.toBeNull();

    // Last, for the reason the test above gives.
    expect(queuedOn).toEqual([expect.stringMatching(LOCKS_THE_EVENT), expect.stringMatching(LOCKS_THE_EVENT)]);
  });

  // A delete keeps the lineup's rows, so a removal that found the event live
  // and queued behind the delete would otherwise take the game out of a
  // deleted event's lineup and tell its attendees (#769).
  it("answers a lineup game's removal queued behind a DELETE 404, and the game stays (#769)", async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);
    const lineupGameId = eventGameEnvelope(
      await request(baseUrl)
        .post(`${EVENTS_PATH}/${eventId}/nominations/direct-add`)
        .set(host.headers)
        .send(await arrangeListEntry(db.client, eventId, host.user.id))
        .expect(201),
      'POST /api/events/:eventId/nominations/direct-add as the host',
    ).id;

    const { statuses, queuedOn } = await race(
      eventId,
      () => deleteEvent(host, eventId),
      () => request(baseUrl).delete(`${EVENTS_PATH}/${eventId}/lineup/${lineupGameId}`).set(host.headers),
    );

    expect(statuses).toEqual([200, 404]);
    await expect(db.client.eventGame.count({ where: { id: lineupGameId } })).resolves.toBe(1);

    // Last, for the reason the first test gives.
    expect(queuedOn).toEqual([expect.stringMatching(LOCKS_THE_EVENT), expect.stringMatching(LOCKS_THE_EVENT)]);
  });

  /**
   * A write beneath the event, queued behind its delete (#1065). The barrier
   * is the delete: it stamps the event's row and holds it uncommitted, so the
   * write reads the event live in front of its lock, then queues on the row.
   * Once the delete commits, the write reads the event under its lock and
   * answers 404, as one arriving after the delete would.
   */
  describe('a write beneath the event, queued behind its delete (#1065)', () => {
    /** The statement an unlocked write queues on: the event's row, as a share. */
    const SHARES_THE_EVENT = /FROM events WHERE id = \$1 FOR SHARE/;

    /**
     * The write's status, the statement it queued on, and the audit rows its
     * actor caused meanwhile, which a refused write leaves at none.
     */
    const behindADelete = async (
      actor: AuthenticatedActor,
      eventId: string,
      send: () => request.Test,
      description: string,
    ) => {
      const { auditRows, result } = await auditRowsDuring(baseUrl, db.client, actor, () =>
        withBarrier(async (barrier) => {
          const { holder } = barrier;

          await holder.begin();
          await expect(
            holder.query('UPDATE events SET deleted_at = now() WHERE id = $1 RETURNING id', [eventId]),
          ).resolves.toHaveLength(1);

          // Deliberately not awaited: it is supposed to be stuck.
          const write = fire(send);

          const waiting = await expectLockWaiter(barrier, {
            heldBy: holder.pid,
            description,
            timeoutMs: REQUEST_REACHES_LOCK_MS,
            exclude: barrierPids(barrier),
            settledEarly: write.settledEarly,
          });

          await holder.commit();

          return { status: (await write.settled).status, queuedOn: waiting.query };
        }),
      );

      return { ...result, auditRows };
    };

    const hostAttendee = (host: AuthenticatedActor, eventId: string) =>
      db.client.eventAttendee.findFirstOrThrow({
        where: { eventId, userId: host.user.id },
        select: { id: true, status: true },
      });

    it('an RSVP queued behind a delete answers 404 and writes nothing (#1065)', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host);
      const attendee = await hostAttendee(host, eventId);

      const { status, queuedOn, auditRows } = await behindADelete(
        host,
        eventId,
        () =>
          request(baseUrl)
            .patch(`${EVENTS_PATH}/${eventId}/attendees/${attendee.id}/status`)
            .set(host.headers)
            .send({ status: EventParticipationStatus.NotAttending }),
        'the RSVP',
      );

      expect(status).toBe(404);
      await expect(hostAttendee(host, eventId)).resolves.toEqual(attendee);
      expect(auditRows).toBe(0);

      // Last, so a run against a lib that doesn't lock fails on the outcome
      // above rather than here.
      expect(queuedOn).toMatch(SHARES_THE_EVENT);
    });

    it('a vote queued behind a delete answers 404 and writes nothing (#1065)', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host);
      const attendee = await hostAttendee(host, eventId);
      const entry = await arrangeListEntry(db.client, eventId, host.user.id);
      const { id: nominationId } = await db.client.eventGameNomination.create({
        data: {
          eventId,
          platformGameId: entry.platformGameId,
          suppliedFromId: entry.suppliedById,
          nominatedById: attendee.id,
          status: NominationStatus.Open,
        },
        select: { id: true },
      });

      const { status, queuedOn, auditRows } = await behindADelete(
        host,
        eventId,
        () =>
          request(baseUrl)
            .post(`${EVENTS_PATH}/${eventId}/nominations/${nominationId}/votes`)
            .set(host.headers)
            .send({ voteType: VoteType.For }),
        'the vote',
      );

      expect(status).toBe(404);
      await expect(db.client.eventGameVote.count({ where: { eventGameNominationId: nominationId } })).resolves.toBe(0);
      expect(auditRows).toBe(0);

      // Last, for the reason the test above gives.
      expect(queuedOn).toMatch(SHARES_THE_EVENT);
    });

    it('a date edit queued behind a delete answers 404 and writes nothing (#1065)', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host);
      const { id: occurrenceId } = await db.client.eventOccurrence.create({
        data: { eventId, status: OccurrenceStatus.Proposed, label: 'Before the race' },
        select: { id: true },
      });

      const { status, queuedOn, auditRows } = await behindADelete(
        host,
        eventId,
        () =>
          request(baseUrl)
            .patch(`${EVENTS_PATH}/${eventId}/occurrences/${occurrenceId}`)
            .set(host.headers)
            .send({ label: 'Too late' }),
        'the date edit',
      );

      expect(status).toBe(404);
      await expect(
        db.client.eventOccurrence.findUniqueOrThrow({ where: { id: occurrenceId }, select: { label: true } }),
      ).resolves.toEqual({ label: 'Before the race' });
      expect(auditRows).toBe(0);

      // A date write takes the row the way a delete does, and checks under it.
      expect(queuedOn).toMatch(LOCKS_THE_EVENT);
    });
  });
});
