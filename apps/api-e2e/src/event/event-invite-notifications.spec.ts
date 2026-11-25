import { NotificationType, SystemRole } from '@bge/database';
import type { Actors, SessionActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import request from 'supertest';
import { inviteEnvelope } from '../household/household-invite-wire';
import type { UnreadNotificationWire } from '../notification/notification-wire';
import { unreadWhen } from '../notification/unread-poll';
import { requireBaseUrl } from '../support/e2e-env';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { createEventClient, EVENTS_PATH } from './event-request';

type Unread = readonly UnreadNotificationWire[];

/**
 * The event invite notifications, driven over HTTP and read back through
 * `GET /api/notifications/unread` (#742): an invite tells its invitee, and an
 * accept or a decline tells the inviter. An invitee has no attendee row until
 * they accept, so nothing follows the attendee any more.
 *
 * The listener runs after the response to the request that caused it, so each
 * test polls for what it expects. Where a user must NOT be told, the test sends
 * them a later notification and waits for that one before checking: a fixed
 * sleep would pass as well if the listener never ran.
 *
 * Actors are arranged before any of them sends a request, as in
 * `event-invites.spec.ts`: the API caches each user's ability on first use and
 * this process cannot evict it (#256).
 */
describe('event invite notifications (#742)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const { createdEventId } = createEventClient(baseUrl);

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const invitesPath = (eventId: string) => `${EVENTS_PATH}/${eventId}/invites`;

  const inviteTo = async (inviter: SessionActor, invitee: SessionActor, eventId: string) =>
    inviteEnvelope(
      await request(baseUrl)
        .post(invitesPath(eventId))
        .set(inviter.headers)
        .send({ userId: invitee.user.id, role: SystemRole.EventParticipant })
        .expect(201),
      'POST /api/events/:eventId/invites',
    ).invite;

  const accept = (actor: SessionActor, inviteId: string) =>
    request(baseUrl).post(`/api/invites/${inviteId}/accept`).set(actor.headers);

  const decline = (actor: SessionActor, inviteId: string) =>
    request(baseUrl).post(`/api/invites/${inviteId}/decline`).set(actor.headers);

  /** A user's display name, or their username when it is unset or blank: how a notification names them. */
  const nameOf = async (actor: SessionActor) => {
    const profile = await db.client.userProfile.findUnique({ where: { userId: actor.user.id } });

    return profile?.displayName || actor.user.username;
  };

  const unread = (actor: SessionActor, predicate: (unread: Unread) => boolean) => unreadWhen(baseUrl, actor, predicate);

  /** The notifications of one type, about one invite. */
  const about = (list: Unread, type: NotificationType, inviteId: string) =>
    list.filter((notification) => notification.type === type && notification.payload['inviteId'] === inviteId);

  const holds = (type: NotificationType, inviteId: string) => (list: Unread) => about(list, type, inviteId).length > 0;

  const titleOf = async (eventId: string) =>
    (await db.client.event.findUniqueOrThrow({ where: { id: eventId }, select: { title: true } })).title;

  it('an invite tells its invitee once, naming the event and the inviter, and tells the inviter nothing', async () => {
    const [host, invitee] = await Promise.all([actors.user(), actors.user()]);
    const eventId = await createdEventId(host);

    const invite = await inviteTo(host, invitee, eventId);

    const told = await unread(invitee, holds(NotificationType.EventInviteReceived, invite.id));

    // Exactly these keys: the invitee's notification never carries an address.
    expect(about(told, NotificationType.EventInviteReceived, invite.id)).toEqual([
      expect.objectContaining({
        payload: {
          eventId,
          eventTitle: await titleOf(eventId),
          inviteId: invite.id,
          inviterName: await nameOf(host),
        },
      }),
    ]);

    // The sentinel: a later invite to the host, which they wait for.
    const otherEventId = await createdEventId(invitee);
    const back = await inviteTo(invitee, host, otherEventId);
    const hostTold = await unread(host, holds(NotificationType.EventInviteReceived, back.id));

    expect(hostTold.map((notification) => notification.type)).toEqual([NotificationType.EventInviteReceived]);
    expect(about(hostTold, NotificationType.EventInviteReceived, invite.id)).toEqual([]);
  });

  it('an invitee named when an event is created is told once, by their invite (#742)', async () => {
    const [host, invitee] = await Promise.all([actors.user(), actors.user()]);

    const eventId = await createdEventId(host, { inviteUserIds: [invitee.user.id] });
    const stored = await db.client.invite.findFirstOrThrow({ where: { eventId, inviteeId: invitee.user.id } });

    const told = await unread(invitee, holds(NotificationType.EventInviteReceived, stored.id));

    expect(told.filter((notification) => notification.payload['eventId'] === eventId)).toEqual([
      expect.objectContaining({
        type: NotificationType.EventInviteReceived,
        payload: expect.objectContaining({ eventId, inviteId: stored.id, inviterName: await nameOf(host) }),
      }),
    ]);
  });

  it('an accept tells the inviter, naming the invitee, and tells the invitee nothing', async () => {
    const [host, invitee] = await Promise.all([actors.user(), actors.user()]);
    const eventId = await createdEventId(host);
    const invite = await inviteTo(host, invitee, eventId);

    await accept(invitee, invite.id).expect(200);

    const told = await unread(host, holds(NotificationType.EventInviteAccepted, invite.id));

    expect(about(told, NotificationType.EventInviteAccepted, invite.id)).toEqual([
      expect.objectContaining({
        payload: {
          eventId,
          eventTitle: await titleOf(eventId),
          inviteId: invite.id,
          inviteeName: await nameOf(invitee),
        },
      }),
    ]);

    // The invitee's own list holds the invite they were sent and nothing of
    // their answer; the sentinel is a later invite, which they wait for.
    const laterEventId = await createdEventId(host);
    const later = await inviteTo(host, invitee, laterEventId);
    const inviteeList = await unread(invitee, holds(NotificationType.EventInviteReceived, later.id));

    expect(inviteeList.map((notification) => notification.type)).not.toContain(NotificationType.EventInviteAccepted);
  });

  it('a decline tells the inviter, naming the invitee', async () => {
    const [host, invitee] = await Promise.all([actors.user(), actors.user()]);
    const eventId = await createdEventId(host);
    const invite = await inviteTo(host, invitee, eventId);

    await decline(invitee, invite.id).expect(200);

    const told = await unread(host, holds(NotificationType.EventInviteDeclined, invite.id));

    expect(about(told, NotificationType.EventInviteDeclined, invite.id)).toEqual([
      expect.objectContaining({
        payload: {
          eventId,
          eventTitle: await titleOf(eventId),
          inviteId: invite.id,
          inviteeName: await nameOf(invitee),
        },
      }),
    ]);
    expect(about(told, NotificationType.EventInviteAccepted, invite.id)).toEqual([]);
  });

  it('a co-host who invited is the one told of the answer, not the host (#742)', async () => {
    const [host, coHost, invitee] = await Promise.all([actors.user(), actors.user(), actors.user()]);
    const eventId = await createdEventId(host);
    await db.client.eventAttendee.create({
      data: {
        event: { connect: { id: eventId } },
        user: { connect: { id: coHost.user.id } },
        role: { create: { role: { connect: { name: SystemRole.EventCoHost } } } },
      },
    });
    const invite = await inviteTo(coHost, invitee, eventId);

    await accept(invitee, invite.id).expect(200);

    const told = await unread(coHost, holds(NotificationType.EventInviteAccepted, invite.id));

    expect(about(told, NotificationType.EventInviteAccepted, invite.id)).toHaveLength(1);

    // The host hears nothing of it: the sentinel is a later invite to them.
    const laterEventId = await createdEventId(coHost);
    const later = await inviteTo(coHost, host, laterEventId);
    const hostList = await unread(host, holds(NotificationType.EventInviteReceived, later.id));

    expect(about(hostList, NotificationType.EventInviteAccepted, invite.id)).toEqual([]);
  });
});
