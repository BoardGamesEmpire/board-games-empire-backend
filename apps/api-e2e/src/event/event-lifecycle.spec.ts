import { EventSchedulingMode, EventStatus, NotificationType, OccurrenceStatus, SystemRole } from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import type { UnreadNotificationWire } from '../notification/notification-wire';
import { unreadWhen } from '../notification/unread-poll';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { createEventClient, EVENTS_PATH } from './event-request';
import { eventEnvelope, listEventsEnvelope, occurrenceEnvelope } from './event-wire';

const CANCELLED = 'This event is cancelled. Reopen it first.';
const ARCHIVED = 'This event is archived. Unarchive it first.';
const NOT_ARCHIVABLE = 'Only a cancelled event, or one whose dates have all passed, can be archived.';

const HOUR = 60 * 60 * 1000;
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

/**
 * Cancel, reopen and archive an event, and the status worked out from its
 * dates, over the real routes and a real database (#795).
 *
 * Events are created through `POST /api/events`, so the creator is the
 * event's host in their next request, as they are for a client. A
 * notification's listener runs after the response, so where a user must NOT
 * have been told, the spec waits for a later notification to the same user
 * and then counts: a fixed sleep would pass as well if the listener never
 * ran.
 */
describe('event cancel, reopen and archive (#795)', () => {
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

  const transition = (actor: AuthenticatedActor, eventId: string, action: string, body: Record<string, unknown> = {}) =>
    request(baseUrl).post(`${EVENTS_PATH}/${eventId}/${action}`).set(actor.headers).send(body);

  const cancel = (actor: AuthenticatedActor, eventId: string, reason?: string) =>
    transition(actor, eventId, 'cancel', reason === undefined ? {} : { reason });

  const readEvent = async (actor: AuthenticatedActor, eventId: string) =>
    eventEnvelope(
      await request(baseUrl).get(`${EVENTS_PATH}/${eventId}`).set(actor.headers).expect(200),
      'GET /api/events/:id',
    );

  const listEvents = async (actor: AuthenticatedActor, query = '') =>
    listEventsEnvelope(
      await request(baseUrl).get(`${EVENTS_PATH}${query}`).set(actor.headers).expect(200),
      `GET /api/events${query}`,
    ).events.map(({ id }) => id);

  const addAttendee = (actor: AuthenticatedActor, eventId: string, userId: string, role: SystemRole) =>
    request(baseUrl).post(`${EVENTS_PATH}/${eventId}/attendees`).set(actor.headers).send({ userId, role });

  const attendeeRowId = async (eventId: string, userId: string) =>
    (
      await db.client.eventAttendee.findUniqueOrThrow({
        where: { eventId_userId: { eventId, userId } },
        select: { id: true },
      })
    ).id;

  /** `actor` answers their invitation, which tells the event's creator: a later notification to wait for. */
  const rsvp = async (actor: AuthenticatedActor, eventId: string) =>
    request(baseUrl)
      .patch(`${EVENTS_PATH}/${eventId}/attendees/${await attendeeRowId(eventId, actor.user.id)}/status`)
      .set(actor.headers)
      .send({ status: 'Attending' })
      .expect(200);

  const notificationsOf = (list: readonly UnreadNotificationWire[], type: NotificationType, eventId: string) =>
    list.filter((notification) => notification.type === type && notification.payload['eventId'] === eventId);

  /** `actor`'s unread list once it holds `count` notifications of `type` for `eventId`. */
  const unreadOnceHolding = (actor: SessionActor, type: NotificationType, eventId: string, count = 1) =>
    unreadWhen(baseUrl, actor, (list) => notificationsOf(list, type, eventId).length >= count);

  const datesOf = (eventId: string) =>
    db.client.eventOccurrence.findMany({
      where: { eventId },
      select: { status: true, cancelReason: true },
      orderBy: { sortOrder: 'asc' },
    });

  describe('cancelling', () => {
    it("cancels the event and its dates with the host's reason, and tells the attendees but not the host", async () => {
      const host = await actors.user();
      const invitee = await actors.user();
      const eventId = await createdEventId(host, {
        inviteUserIds: [invitee.user.id],
        occurrences: [{ startDate: hoursFromNow(24) }],
      });

      const cancelled = eventEnvelope(await cancel(host, eventId, 'Snowed in').expect(200), 'POST cancel');

      expect(cancelled.status).toBe(EventStatus.Cancelled);
      expect(cancelled.cancelReason).toBe('Snowed in');
      await expect(datesOf(eventId)).resolves.toEqual([
        { status: OccurrenceStatus.Cancelled, cancelReason: 'Snowed in' },
      ]);

      const inviteeList = await unreadOnceHolding(invitee, NotificationType.EventCancelled, eventId);
      expect(notificationsOf(inviteeList, NotificationType.EventCancelled, eventId)).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ reason: 'Snowed in' }) }),
      ]);

      // The sentinel: the invitee's answer tells the host. Once it arrives,
      // a cancel notification to the host would have too.
      await rsvp(invitee, eventId);
      const hostList = await unreadOnceHolding(host, NotificationType.EventRsvpReceived, eventId);
      expect(notificationsOf(hostList, NotificationType.EventCancelled, eventId)).toEqual([]);
    });

    it('answers a retry with another reason 200, keeping the first reason and telling nobody again', async () => {
      const host = await actors.user();
      const invitee = await actors.user();
      const eventId = await createdEventId(host, { inviteUserIds: [invitee.user.id] });

      await cancel(host, eventId, 'First reason').expect(200);
      await unreadOnceHolding(invitee, NotificationType.EventCancelled, eventId);

      const retried = eventEnvelope(await cancel(host, eventId, 'Second reason').expect(200), 'POST cancel (retry)');
      expect(retried.cancelReason).toBe('First reason');
      expect(retried.status).toBe(EventStatus.Cancelled);

      // The sentinel: a reopen tells the invitee once more.
      await transition(host, eventId, 'reopen').expect(200);
      const list = await unreadOnceHolding(invitee, NotificationType.EventReopened, eventId);
      expect(notificationsOf(list, NotificationType.EventCancelled, eventId)).toHaveLength(1);
    });

    it.each([SystemRole.EventOrganizer, SystemRole.EventModerator])(
      'refuses a %s, who can still edit the event',
      async (role) => {
        const host = await actors.user();
        const delegate = await actors.user();
        const eventId = await createdEventId(host);
        await addAttendee(host, eventId, delegate.user.id, role).expect(201);

        await cancel(delegate, eventId).expect(403);
        await transition(delegate, eventId, 'archive').expect(403);
        expect((await readEvent(host, eventId)).status).not.toBe(EventStatus.Cancelled);

        // Control: the same delegate edits the event.
        await request(baseUrl)
          .patch(`${EVENTS_PATH}/${eventId}`)
          .set(delegate.headers)
          .send({ title: 'Edited by a delegate' })
          .expect(200);
      },
    );

    it("lets a household admin who doesn't attend cancel the household's event, and not its moderator", async () => {
      const owner = await actors.user();
      const admin = await actors.user();
      const member = await actors.user();
      const moderator = await actors.user();
      const { household } = await actors.householdWithMembers({
        owner,
        members: [
          { actor: admin, role: SystemRole.HouseholdAdmin },
          { actor: member, role: SystemRole.HouseholdMember },
        ],
      });
      const eventId = await createdEventId(member, { householdId: household.id });
      await addAttendee(member, eventId, moderator.user.id, SystemRole.EventModerator).expect(201);

      const edit = (actor: AuthenticatedActor, title: string) =>
        request(baseUrl).patch(`${EVENTS_PATH}/${eventId}`).set(actor.headers).send({ title }).expect(200);

      // Control: both edit the event.
      await edit(admin, 'Edited by a household admin');
      await edit(moderator, 'Edited by a moderator');

      const cancelled = eventEnvelope(await cancel(admin, eventId).expect(200), 'POST cancel as a household admin');
      expect(cancelled.status).toBe(EventStatus.Cancelled);
      await cancel(moderator, eventId).expect(403);

      // Cancelled, so archivable, and still not the admin's to archive.
      await transition(admin, eventId, 'archive').expect(403);
      await transition(member, eventId, 'archive').expect(200);
    });

    // The grant is checked against the event before its state, so someone it
    // doesn't reach learns nothing of the event from the answer.
    it("answers 403, not the event's state, to someone whose grant doesn't reach it", async () => {
      const host = await actors.user();
      const outsider = await actors.user();
      const eventId = await createdEventId(host, { occurrences: [{ startDate: hoursFromNow(24) }] });
      // The outsider hosts an event of their own, so the route's check passes them.
      await createdEventId(outsider);

      await transition(outsider, eventId, 'archive').expect(403);

      // Control: the host learns the event isn't archivable yet.
      expect((await transition(host, eventId, 'archive').expect(400)).body.message).toBe(NOT_ARCHIVABLE);
    });

    it('refuses a new date on a cancelled event until it is reopened', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host, { schedulingMode: EventSchedulingMode.MultiDay });
      await cancel(host, eventId).expect(200);

      const addDate = () =>
        request(baseUrl)
          .post(`${EVENTS_PATH}/${eventId}/occurrences`)
          .set(host.headers)
          .send({ label: 'Saturday', startDate: hoursFromNow(48) });

      expect((await addDate().expect(400)).body.message).toBe(CANCELLED);
      await expect(db.client.eventOccurrence.count({ where: { eventId } })).resolves.toBe(0);

      // Control: reopened, it takes the date.
      await transition(host, eventId, 'reopen').expect(200);
      await addDate().expect(201);
    });

    // A cancel and a confirm racing end in a legal state either way: the
    // date is never left Confirmed under a cancelled event.
    it('never leaves a date Confirmed when a cancel races its confirm', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host, {
        schedulingMode: EventSchedulingMode.Poll,
        occurrences: [{ startDate: hoursFromNow(24) }],
      });
      const [{ id: occurrenceId }] = await db.client.eventOccurrence.findMany({
        where: { eventId },
        select: { id: true },
      });

      const [cancelled, confirmed] = await Promise.all([
        cancel(host, eventId),
        request(baseUrl).post(`${EVENTS_PATH}/${eventId}/occurrences/${occurrenceId}/confirm`).set(host.headers),
      ]);

      // A confirm that came first answers 201, as the route always has; one
      // that came second finds the event cancelled.
      expect(cancelled.status).toBe(200);
      expect([201, 400]).toContain(confirmed.status);
      const [date] = await datesOf(eventId);
      expect([OccurrenceStatus.Cancelled, OccurrenceStatus.Declined]).toContain(date.status);
    });
  });

  describe('reopening', () => {
    it('works the status out from the dates again, and tells the attendees', async () => {
      const host = await actors.user();
      const invitee = await actors.user();
      const eventId = await createdEventId(host, {
        inviteUserIds: [invitee.user.id],
        occurrences: [{ startDate: hoursFromNow(24) }],
      });
      await cancel(host, eventId).expect(200);

      const reopened = eventEnvelope(await transition(host, eventId, 'reopen').expect(200), 'POST reopen');

      // Its one date stays cancelled, so no date counts.
      expect(reopened.status).toBe(EventStatus.Planning);
      expect(reopened.cancelReason).toBeNull();
      const list = await unreadOnceHolding(invitee, NotificationType.EventReopened, eventId);
      expect(notificationsOf(list, NotificationType.EventReopened, eventId)).toHaveLength(1);
    });
  });

  describe('archiving', () => {
    it('archives only a cancelled or finished event, and unarchives it to what it was', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host, { occurrences: [{ startDate: hoursFromNow(24) }] });

      // Scheduled: cancel it first.
      expect((await transition(host, eventId, 'archive').expect(400)).body.message).toBe(NOT_ARCHIVABLE);

      await cancel(host, eventId).expect(200);
      const archived = eventEnvelope(await transition(host, eventId, 'archive').expect(200), 'POST archive');
      expect(archived.status).toBe(EventStatus.Archived);

      expect((await transition(host, eventId, 'reopen').expect(400)).body.message).toBe(ARCHIVED);
      // A cancel retry finds it still cancelled, and answers with it as it is.
      const retried = eventEnvelope(
        await cancel(host, eventId, 'Another reason').expect(200),
        'POST cancel (archived)',
      );
      expect(retried.status).toBe(EventStatus.Archived);
      expect(retried.cancelReason).toBeNull();

      const unarchived = eventEnvelope(await transition(host, eventId, 'unarchive').expect(200), 'POST unarchive');
      expect(unarchived.status).toBe(EventStatus.Cancelled);
    });

    it('archives an event whose dates have all passed', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host, {
        occurrences: [{ startDate: hoursFromNow(-30), endDate: hoursFromNow(-26) }],
      });

      const archived = eventEnvelope(await transition(host, eventId, 'archive').expect(200), 'POST archive');
      expect(archived.status).toBe(EventStatus.Archived);

      // Over and put away: it is not cancelled, so a cancel waits for an unarchive.
      expect((await cancel(host, eventId).expect(400)).body.message).toBe(ARCHIVED);

      // A reopen finds it already not cancelled, as a retry of one that
      // landed before the archive would, and answers with it as it is.
      const reopened = eventEnvelope(await transition(host, eventId, 'reopen').expect(200), 'POST reopen (archived)');
      expect(reopened.status).toBe(EventStatus.Archived);
    });

    it('leaves an archived event out of the list unless asked for, and serves it by id', async () => {
      const host = await actors.user();
      const archivedId = await createdEventId(host);
      const liveId = await createdEventId(host);
      await cancel(host, archivedId).expect(200);
      await transition(host, archivedId, 'archive').expect(200);

      expect(await listEvents(host)).toEqual([liveId]);
      // `false` as a query string is still false.
      expect(await listEvents(host, '?includeArchived=false')).toEqual([liveId]);
      expect(new Set(await listEvents(host, '?includeArchived=true'))).toEqual(new Set([liveId, archivedId]));
      expect((await readEvent(host, archivedId)).status).toBe(EventStatus.Archived);
    });
  });

  describe('the status worked out from the dates', () => {
    it.each([
      ['Planning with no date', [], EventStatus.Planning],
      ['Scheduled before its date', [{ startDate: hoursFromNow(24) }], EventStatus.Scheduled],
      [
        'Ongoing between its start and its end',
        [{ startDate: hoursFromNow(-1), endDate: hoursFromNow(2) }],
        EventStatus.Ongoing,
      ],
      [
        'Completed once it has ended',
        [{ startDate: hoursFromNow(-5), endDate: hoursFromNow(-2) }],
        EventStatus.Completed,
      ],
    ])('reads %s', async (_, occurrences, status) => {
      const host = await actors.user();
      const created = eventEnvelope(await createEvent(host, { occurrences }).expect(201), 'POST /api/events');

      expect(created.status).toBe(status);
      expect((await readEvent(host, created.id)).status).toBe(status);
    });

    it('reads a poll Scheduled once one of its dates is confirmed, with no write to the event', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host, {
        schedulingMode: EventSchedulingMode.Poll,
        occurrences: [{ startDate: hoursFromNow(24) }, { startDate: hoursFromNow(48) }],
      });
      expect((await readEvent(host, eventId)).status).toBe(EventStatus.Planning);

      const [{ id: occurrenceId }] = await db.client.eventOccurrence.findMany({
        where: { eventId },
        select: { id: true },
        orderBy: { sortOrder: 'asc' },
      });
      occurrenceEnvelope(
        await request(baseUrl)
          .post(`${EVENTS_PATH}/${eventId}/occurrences/${occurrenceId}/confirm`)
          .set(host.headers)
          .expect(201),
        'POST confirm',
      );

      expect((await readEvent(host, eventId)).status).toBe(EventStatus.Scheduled);
    });
  });
});
