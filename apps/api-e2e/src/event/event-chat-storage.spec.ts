import type { Actors, AuthenticatedActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import type { Barrier, BarrierConnection, PendingStatement } from '../support/lock-barrier';
import { expectLockWaiter, withBarrier } from '../support/lock-barrier';
import { readShippedSql } from '../support/shipped-sql';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { createEventClient, EVENTS_PATH } from './event-request';
import { occurrenceEnvelope } from './event-wire';

/** The row the shipped sequence statement returns. */
interface SequenceRow {
  readonly last_sequence: number;
}

/** One chat message as a spec arranges it; every column not named takes its null or default. */
interface ArrangedMessage {
  readonly authorId?: string | null;
  readonly clientRequestId?: string | null;
  readonly eventId: string;
  readonly occurrence?: { readonly id: string; readonly label: string | null; readonly startDate: Date | null };
  readonly replyToId?: string | null;
  readonly sequence: number;
}

/**
 * What the event chat tables guarantee on their own, in Postgres (#1543).
 *
 * The sequence is the statement `nextChatSequence` ships, lifted from its
 * source rather than copied, run on barrier connections so the order two
 * sends commit in can be held still and looked at. The rest are the keys:
 * a reply stays inside its event chat, a deleted account leaves its messages
 * without a name, and a removed occurrence leaves its tag's snapshot.
 *
 * Messages are written with raw inserts. The send route doesn't exist yet,
 * and these are the database's guarantees, which hold whatever writes the row.
 * Events and occurrences are made through their routes, as the other event
 * specs make them.
 */
describe('event chat storage (#1543)', () => {
  const baseUrl = requireBaseUrl(process.env);

  /** The statement `nextChatSequence` ships, binding `${eventId}`. */
  const nextSequence = readShippedSql('libs/api/event/src/lib/chat/chat-sequence.ts', ['eventId'], {
    after: 'nextChatSequence',
    matching: /ON CONFLICT \(event_id\) DO UPDATE/,
  });

  /**
   * A raw message insert. `id` and `updated_at` have no database default
   * (Prisma fills both on its own writes), so the insert supplies them.
   */
  const INSERT_MESSAGE = `
    INSERT INTO event_chat_messages (
      id, event_id, author_id, sequence, body, reply_to_id,
      occurrence_id, occurrence_tagged, occurrence_label, occurrence_start_date,
      client_request_id, updated_at
    )
    VALUES ($1, $2, $3, $4, 'hello', $5, $6, $7, $8, $9, $10, now())
    RETURNING id
  `;

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

  const insertMessage = async (connection: BarrierConnection, message: ArrangedMessage): Promise<string> => {
    const [row] = await connection.query<{ id: string }>(INSERT_MESSAGE, [
      randomUUID(),
      message.eventId,
      message.authorId ?? null,
      message.sequence,
      message.replyToId ?? null,
      message.occurrence?.id ?? null,
      message.occurrence !== undefined,
      message.occurrence?.label ?? null,
      message.occurrence?.startDate ?? null,
      message.clientRequestId ?? null,
    ]);

    if (row === undefined) {
      throw new Error(`The message insert into event ${message.eventId} returned no row`);
    }

    return row.id;
  };

  const addedOccurrence = async (actor: AuthenticatedActor, eventId: string) =>
    occurrenceEnvelope(
      await request(baseUrl)
        .post(`${EVENTS_PATH}/${eventId}/occurrences`)
        .set(actor.headers)
        .send({ label: 'Saturday' })
        .expect(201),
      'POST /api/events/:eventId/occurrences',
    );

  const counterOf = async (eventId: string) =>
    (await db.client.eventChatCounter.findUnique({ where: { eventId }, select: { lastSequence: true } }))?.lastSequence;

  /**
   * Holds the holder's sequence in an open transaction and issues the waiter's,
   * asserting the waiter queues on the holder's lock rather than answering.
   * The waiter is the barrier's own connection, so it is found by the holder's
   * pid, as `expectLockWaiter` asks, and checked to be that connection.
   */
  const holdAndQueue = async (
    barrier: Barrier,
    eventId: string,
    holderGets: number,
  ): Promise<PendingStatement<SequenceRow>> => {
    const { holder, waiter } = barrier;

    await holder.begin();
    await expect(holder.query<SequenceRow>(nextSequence.text, [eventId])).resolves.toEqual([
      { last_sequence: holderGets },
    ]);

    await waiter.begin();
    const pending = waiter.issue<SequenceRow>(nextSequence.text, [eventId], "the second send's sequence");

    // Not expectBackendsQueuedBehind: it skips the barrier's own waiter, which is the send queued here.
    const queued = await expectLockWaiter(barrier, {
      heldBy: holder.pid,
      description: "the second send's sequence",
      settledEarly: () => (pending.settled() ? 'it returned before the first send ended' : undefined),
    });
    expect(queued.pid).toBe(waiter.pid);
    expect(pending.settled()).toBe(false);

    return pending;
  };

  it('gives two concurrent sends consecutive numbers, in commit order (#1543)', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);
    // The counter row exists, so both sends take the update arm.
    await db.client.eventChatCounter.create({ data: { eventId } });

    await withBarrier(async (barrier) => {
      const pending = await holdAndQueue(barrier, eventId, 1);

      await barrier.holder.commit();

      await expect(pending.result()).resolves.toEqual([{ last_sequence: 2 }]);
      await barrier.waiter.commit();
    });

    expect(await counterOf(eventId)).toBe(2);
  });

  // Two first messages race to insert the counter row. The second waits on the
  // first's inserted key and then takes the update arm, rather than failing on
  // the primary key (#1543).
  it('numbers two racing first messages 1 and 2, with no counter row yet', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);
    expect(await counterOf(eventId)).toBeUndefined();

    await withBarrier(async (barrier) => {
      const pending = await holdAndQueue(barrier, eventId, 1);

      await barrier.holder.commit();

      await expect(pending.result()).resolves.toEqual([{ last_sequence: 2 }]);
      await barrier.waiter.commit();
    });

    expect(await counterOf(eventId)).toBe(2);
  });

  it('leaves no gap when a send rolls back', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);

    await withBarrier(async (barrier) => {
      const pending = await holdAndQueue(barrier, eventId, 1);

      await barrier.holder.rollback();

      await expect(pending.result()).resolves.toEqual([{ last_sequence: 1 }]);
      await barrier.waiter.commit();
    });

    expect(await counterOf(eventId)).toBe(1);
  });

  it("refuses a reply that points at another event's message", async () => {
    const host = await actors.user();
    const [eventA, eventB] = await Promise.all([createdEventId(host), createdEventId(host)]);

    await withBarrier(async ({ holder }) => {
      const original = await insertMessage(holder, { eventId: eventA, authorId: host.user.id, sequence: 1 });

      // The control: a reply in the same event chat is accepted.
      await insertMessage(holder, { eventId: eventA, authorId: host.user.id, sequence: 2, replyToId: original });

      await expect(
        insertMessage(holder, { eventId: eventB, authorId: host.user.id, sequence: 1, replyToId: original }),
      ).rejects.toMatchObject({ code: '23503', constraint: 'event_chat_messages_event_id_reply_to_id_fkey' });
    });

    expect(await db.client.eventChatMessage.count({ where: { eventId: eventB } })).toBe(0);
  });

  // Each author is a fresh account that shares nothing: it owns only what
  // signing up gives it (sessions, its sign-in method, profile, preferences,
  // role and wishlist), all of which cascade, and it created neither event.
  // So nothing but the chat's own keys decides the delete (#1277).
  //
  // Two authors, because the client request key is per author across every
  // event: one author can't hold the same key in two events. What is under
  // test is that once both are deleted, their null-author rows share it.
  it('keeps a message and nulls its author when the account is deleted', async () => {
    const host = await actors.user();
    const [first, second] = await Promise.all([actors.user(), actors.user()]);
    const [eventA, eventB] = await Promise.all([createdEventId(host), createdEventId(host)]);
    const clientRequestId = `send-${randomUUID()}`;

    await withBarrier(async ({ holder }) => {
      const deleteUser = (userId: string) =>
        holder.query<{ id: string }>('DELETE FROM users WHERE id = $1 RETURNING id', [userId]);

      const messages = [
        await insertMessage(holder, { eventId: eventA, authorId: first.user.id, sequence: 1, clientRequestId }),
        await insertMessage(holder, { eventId: eventB, authorId: second.user.id, sequence: 1, clientRequestId }),
      ];

      await expect(deleteUser(first.user.id)).resolves.toEqual([{ id: first.user.id }]);
      await expect(deleteUser(second.user.id)).resolves.toEqual([{ id: second.user.id }]);

      const kept = await db.client.eventChatMessage.findMany({
        where: { id: { in: messages } },
        select: { id: true, authorId: true, clientRequestId: true },
        orderBy: { id: 'asc' },
      });
      expect(kept).toEqual([...messages].sort().map((id) => ({ id, authorId: null, clientRequestId })));

      // Null authors are distinct under the per-author key, so an orphaned
      // key blocks no one.
      await expect(
        insertMessage(holder, { eventId: eventA, authorId: null, sequence: 2, clientRequestId }),
      ).resolves.toEqual(expect.any(String));
    });
  });

  it('nulls the occurrence tag and keeps its snapshot when the occurrence is removed', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);
    const occurrence = await addedOccurrence(host, eventId);
    const startDate = new Date('2027-03-06T18:00:00.000Z');

    await withBarrier(async ({ holder }) => {
      const messageId = await insertMessage(holder, {
        eventId,
        authorId: host.user.id,
        sequence: 1,
        occurrence: { id: occurrence.id, label: 'Saturday', startDate },
      });

      await expect(
        holder.query<{ id: string }>('DELETE FROM event_occurrences WHERE id = $1 RETURNING id', [occurrence.id]),
      ).resolves.toEqual([{ id: occurrence.id }]);

      const message = await db.client.eventChatMessage.findUniqueOrThrow({
        where: { id: messageId },
        select: { occurrenceId: true, occurrenceTagged: true, occurrenceLabel: true, occurrenceStartDate: true },
      });
      expect(message).toEqual({
        occurrenceId: null,
        occurrenceTagged: true,
        occurrenceLabel: 'Saturday',
        occurrenceStartDate: startDate,
      });
    });
  });
});
