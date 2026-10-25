import { FriendshipStatus, isPrismaUniqueConstraintError, NotificationType } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createEnvelope } from '../household/household-wire';
import type { UnreadNotificationWire } from '../notification/notification-wire';
import { unreadWhen } from '../notification/unread-poll';
import { requireBaseUrl } from '../support/e2e-env';
import { expectBackendsQueuedBehind, withBarrier } from '../support/lock-barrier';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { createEventClient, EVENTS_PATH } from './event-request';
import { eventDetailEnvelope, eventEnvelope } from './event-wire';

type Unread = readonly UnreadNotificationWire[];

const HOUSEHOLDS_PATH = '/api/households';

/**
 * `POST /events` with a client request id (#252), against real Postgres: the
 * `(createdById, clientRequestId)` unique and the lookup that runs before the
 * create's checks are the mechanism, so a mocked database can show neither.
 *
 * A replay answers with the original event whatever has changed since: its
 * household deleted, an invitee's block on its creator, the event deleted, or
 * a retry whose payload differs. It adds no attendee and notifies no one again.
 *
 * Every actor is a plain `User`, never the Owner sentinel, whose `manage:all`
 * would pass every check for reasons that have nothing to do with the key.
 * The invite notification's listener runs after the response, so where a user
 * must NOT be told twice the test sends them a later notification and waits
 * for that one before counting: a fixed sleep would pass as well if the
 * listener never ran.
 */
describe('event create idempotency (#252)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const { createEvent, createdEventId } = createEventClient(baseUrl);

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  /** Random, never sequential — see `prepareSignup`'s note on #268. */
  const freshKey = (): string => `e2e-key-${randomUUID()}`;

  const eventsCreatedBy = (actor: SessionActor) => db.client.event.count({ where: { createdById: actor.user.id } });

  const createHousehold = async (actor: SessionActor): Promise<string> =>
    createEnvelope(
      await request(baseUrl).post(HOUSEHOLDS_PATH).set(actor.headers).send({ name: 'Game night crew' }).expect(201),
      `POST ${HOUSEHOLDS_PATH}`,
    ).household.id;

  /** The invite notifications `list` holds for one event. */
  const invitesTo = (list: Unread, eventId: string) =>
    list.filter(
      (notification) =>
        notification.type === NotificationType.EventInviteReceived && notification.payload['eventId'] === eventId,
    );

  /** `actor`'s unread list, once it holds an invite to `eventId`. */
  const unreadOnceInvitedTo = (actor: SessionActor, eventId: string) =>
    unreadWhen(baseUrl, actor, (list) => invitesTo(list, eventId).length > 0);

  describe('a repeat create with the same key', () => {
    it('answers 201 both times with one event, and the same response', async () => {
      const actor = await actors.user();
      const body = { title: 'Keyed event', clientRequestId: freshKey() };

      const first = await createEvent(actor, body).expect(201);
      const second = await createEvent(actor, body).expect(201);

      expect(eventEnvelope(second, 'POST /api/events (replay)').id).toBe(eventEnvelope(first, 'POST /api/events').id);

      // A replay looks like the create on the wire, so a client can't tell its
      // retry was one. That is what the key is for.
      expect(second.body).toEqual(first.body);
      await expect(eventsCreatedBy(actor)).resolves.toBe(1);
    });

    it('answers 201 to two identical requests in flight at once, with one event', async () => {
      // Both requests must miss the first lookup, or the second is an ordinary
      // replay and the unique never fires. So the household row is held: each
      // request looks its key up, finds nothing, then waits at the create's
      // share lock on the household. Released together, one inserts; the other
      // waits on its unique entry, fails once that commits, and its second
      // lookup finds the first one's event. Two requests, not a burst: the
      // throttler keys on handler and IP, and a burst would test the rate limit.
      const actor = await actors.user();
      const householdId = await createHousehold(actor);
      const body = { title: 'Concurrent event', householdId, clientRequestId: freshKey() };

      const [first, second] = await withBarrier(async (barrier) => {
        const { holder } = barrier;

        await holder.begin();
        await holder.query('SELECT id FROM households WHERE id = $1 FOR UPDATE', [householdId]);

        // supertest sends nothing until asked, so `then` sends both now.
        const inFlight = [createEvent(actor, body), createEvent(actor, body)].map((test) =>
          test.then((response) => response),
        );

        await expectBackendsQueuedBehind(barrier, {
          heldBy: holder.pid,
          count: 2,
          description: 'both creates, at the household share lock',
        });
        await holder.commit();

        return Promise.all(inFlight);
      });

      // Asserted rather than chained, so a 500 reports its status.
      expect([first.status, second.status]).toEqual([201, 201]);
      expect(eventEnvelope(second, 'POST /api/events (concurrent B)').id).toBe(
        eventEnvelope(first, 'POST /api/events (concurrent A)').id,
      );
      await expect(eventsCreatedBy(actor)).resolves.toBe(1);
    });

    it('returns the original, and ignores a retry that changes the title and adds an invitee', async () => {
      const [host, invitee, latecomer] = [await actors.user(), await actors.user(), await actors.user()];
      const clientRequestId = freshKey();

      const original = eventEnvelope(
        await createEvent(host, { title: 'Original title', inviteUserIds: [invitee.user.id], clientRequestId }).expect(
          201,
        ),
        'POST /api/events',
      );

      // The original's notification lands first, so a second one from the
      // replay could not be mistaken for it.
      await unreadOnceInvitedTo(invitee, original.id);

      const replay = eventEnvelope(
        await createEvent(host, {
          title: 'Changed title',
          inviteUserIds: [invitee.user.id, latecomer.user.id],
          clientRequestId,
        }).expect(201),
        'POST /api/events (divergent replay)',
      );

      expect(replay.id).toBe(original.id);
      expect(replay.title).toBe('Original title');
      await expect(
        db.client.event.findUniqueOrThrow({ where: { id: original.id }, select: { title: true } }),
      ).resolves.toEqual({ title: 'Original title' });
      await expect(
        db.client.eventAttendee.count({ where: { eventId: original.id, userId: latecomer.user.id } }),
      ).resolves.toBe(0);

      // The sentinel: a later invite to both. Once it reaches each of them, so
      // would anything the replay had sent.
      const sentinelId = await createdEventId(host, { inviteUserIds: [invitee.user.id, latecomer.user.id] });

      expect(invitesTo(await unreadOnceInvitedTo(invitee, sentinelId), original.id)).toHaveLength(1);
      expect(invitesTo(await unreadOnceInvitedTo(latecomer, sentinelId), original.id)).toHaveLength(0);
    });

    it('answers 201 with the original event after its household was deleted', async () => {
      // The lookup runs before the create's checks. Caught after them instead,
      // the household's absence would turn the retry of a create that
      // succeeded into a refusal.
      const owner = await actors.user();
      const householdId = await createHousehold(owner);
      const clientRequestId = freshKey();

      const original = eventEnvelope(
        await createEvent(owner, { householdId, clientRequestId }).expect(201),
        'POST /api/events',
      );

      await request(baseUrl).delete(`${HOUSEHOLDS_PATH}/${householdId}`).set(owner.headers).expect(200);

      // The control: the same create without the key is now refused. No role
      // renders for a deleted household, so its create grant is gone.
      await createEvent(owner, { householdId }).expect(403);

      const replay = eventEnvelope(
        await createEvent(owner, { householdId, clientRequestId }).expect(201),
        'POST /api/events (replay after the household was deleted)',
      );

      expect(replay.id).toBe(original.id);
      await expect(eventsCreatedBy(owner)).resolves.toBe(1);
    });

    it('answers 201 with the original event after an invitee blocked its creator', async () => {
      // The invite checks run in the create's transaction, after the lookup. A
      // block since the original refuses a new create with that invitee, and
      // must not refuse the retry of the one that succeeded.
      const [host, invitee] = [await actors.user(), await actors.user()];
      const body = { inviteUserIds: [invitee.user.id], clientRequestId: freshKey() };

      const original = eventEnvelope(await createEvent(host, body).expect(201), 'POST /api/events');

      // Written as the friendship service leaves a block: the blocker is the row's requester.
      await db.client.friendship.create({
        data: {
          requesterId: invitee.user.id,
          addresseeId: host.user.id,
          pairKey: [invitee.user.id, host.user.id].sort().join(':'),
          status: FriendshipStatus.Blocked,
          respondedAt: new Date(),
        },
      });

      // The control: the same create without the key is now refused.
      await createEvent(host, { inviteUserIds: [invitee.user.id] }).expect(403);

      const replay = eventEnvelope(
        await createEvent(host, body).expect(201),
        'POST /api/events (replay after the invitee blocked the creator)',
      );

      expect(replay.id).toBe(original.id);
      await expect(eventsCreatedBy(host)).resolves.toBe(1);
    });

    it('leaves an attendee removed since out of the replay, as the event read does', async () => {
      // A replay reads the event's attendees under their own read ceiling, not
      // the create's unscoped include: a retry must not hand back who was
      // removed, or a roster the creator may no longer read.
      const [host, stays, removed] = [await actors.user(), await actors.user(), await actors.user()];
      const body = { inviteUserIds: [stays.user.id, removed.user.id], clientRequestId: freshKey() };

      const eventId = eventEnvelope(await createEvent(host, body).expect(201), 'POST /api/events').id;
      const { id: removedRowId } = await db.client.eventAttendee.findFirstOrThrow({
        where: { eventId, userId: removed.user.id },
        select: { id: true },
      });

      await request(baseUrl)
        .delete(`${EVENTS_PATH}/${eventId}/attendees/${removedRowId}`)
        .set(host.headers)
        .expect(200);

      const replay = eventDetailEnvelope(
        await createEvent(host, body).expect(201),
        'POST /api/events (replay after an attendee was removed)',
      );
      const detail = eventDetailEnvelope(
        await request(baseUrl).get(`${EVENTS_PATH}/${eventId}`).set(host.headers).expect(200),
        `GET ${EVENTS_PATH}/${eventId}`,
      );

      // Sorted: attendees created together share a `createdAt`, so their ids
      // decide the order, and the event read is the order to match.
      expect(replay.attendees.map(({ userId }) => userId).sort()).toEqual([host.user.id, stays.user.id].sort());
      expect(replay.attendees.map(({ id }) => id)).toEqual(detail.attendees.map(({ id }) => id));
    });

    it('answers 201 with the original event after the event was deleted', async () => {
      // The lookup ignores soft delete: the deleted event is still the create's
      // outcome, and a second event would silently defeat the key.
      const actor = await actors.user();
      const clientRequestId = freshKey();

      const original = eventEnvelope(await createEvent(actor, { clientRequestId }).expect(201), 'POST /api/events');

      await request(baseUrl).delete(`${EVENTS_PATH}/${original.id}`).set(actor.headers).expect(200);

      const replay = eventEnvelope(
        await createEvent(actor, { clientRequestId }).expect(201),
        'POST /api/events (replay after the event was deleted)',
      );

      expect(replay.id).toBe(original.id);
      expect(replay.deletedAt).not.toBeNull();
      await expect(eventsCreatedBy(actor)).resolves.toBe(1);
    });
  });

  describe('keys', () => {
    it('scopes a key to its creator, so the same key from two users makes two events', async () => {
      const [first, second] = [await actors.user(), await actors.user()];
      const clientRequestId = freshKey();

      const mine = await createdEventId(first, { clientRequestId });
      const theirs = await createdEventId(second, { clientRequestId });

      expect(theirs).not.toBe(mine);
      await expect(eventsCreatedBy(first)).resolves.toBe(1);
      await expect(eventsCreatedBy(second)).resolves.toBe(1);
    });

    it('trims a padded key, so a retry that differs only in whitespace replays', async () => {
      const actor = await actors.user();
      const clientRequestId = freshKey();

      const padded = await createdEventId(actor, { clientRequestId: `  ${clientRequestId}  ` });
      const bare = await createdEventId(actor, { clientRequestId });

      expect(bare).toBe(padded);
      await expect(
        db.client.event.findUniqueOrThrow({ where: { id: padded }, select: { clientRequestId: true } }),
      ).resolves.toEqual({ clientRequestId });
    });

    it.each([
      ['blank', ''],
      ['whitespace only', '   '],
      ['129 characters', 'k'.repeat(129)],
    ])('answers 400 to a key that is %s, and makes nothing', async (_, clientRequestId) => {
      const actor = await actors.user();

      await createEvent(actor, { clientRequestId }).expect(400);

      await expect(eventsCreatedBy(actor)).resolves.toBe(0);
    });
  });

  describe('guards', () => {
    it('refuses to rewrite the key through PATCH, so a queued retry still finds its event (#534)', async () => {
      const actor = await actors.user();
      const clientRequestId = freshKey();
      const id = await createdEventId(actor, { title: 'Keyed event', clientRequestId });

      await request(baseUrl)
        .patch(`${EVENTS_PATH}/${id}`)
        .set(actor.headers)
        .send({ title: 'Renamed', clientRequestId: freshKey() })
        .expect(400);

      // Refused whole, not stripped: the title in the same body did not land.
      await expect(
        db.client.event.findUniqueOrThrow({ where: { id }, select: { title: true, clientRequestId: true } }),
      ).resolves.toEqual({ title: 'Keyed event', clientRequestId });
    });

    it('holds a second event under the same creator and key to a unique violation', async () => {
      // The constraint the second lookup relies on: a concurrent duplicate
      // only reaches it because the database refuses the second insert.
      const actor = await actors.user();
      const clientRequestId = freshKey();
      const data = { title: 'Probe', createdById: actor.user.id, clientRequestId };

      await db.client.event.create({ data });

      const duplicate = await db.client.event.create({ data }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(isPrismaUniqueConstraintError(duplicate)).toBe(true);
    });
  });
});
