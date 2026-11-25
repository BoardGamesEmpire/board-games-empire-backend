import { FriendshipStatus, InviteStatus, InviteType, QuotaScope, SystemRole } from '@bge/database';
import type { Actors, AuthenticatedActor, SessionActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import request from 'supertest';
import { inviteEnvelope, inviteListEnvelope, revokeEnvelope } from '../household/household-invite-wire';
import { requireBaseUrl } from '../support/e2e-env';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { createEventClient, EVENTS_PATH } from './event-request';

/** `allowMemberInvites` off refuses a participant with this code (#742). */
const MEMBER_INVITES_OFF = 'MEMBER_INVITES_OFF';

/**
 * Inviting someone to an event (#742): `POST /api/events/:eventId/invites`
 * writes an invite, not an attendee. The invitee has no attendee row and no
 * event role until they accept. The host lists the event's invites and
 * revokes one someone else sent; the event's delete revokes every open one.
 *
 * Actors and rosters are arranged before any of them sends a request: the API
 * caches each user's ability on first use, and this process cannot evict it
 * (#256). Attendees are seated in the database, so these tests do not depend
 * on how the direct add treats a user with an account.
 */
describe('event invites (#742)', () => {
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

  const { createdEventId } = createEventClient(baseUrl);

  const invitesPath = (eventId: string) => `${EVENTS_PATH}/${eventId}/invites`;

  const invite = (actor: AuthenticatedActor, eventId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(invitesPath(eventId)).set(actor.headers).send(body);

  const sentInvite = async (actor: AuthenticatedActor, eventId: string, body: Record<string, unknown>) =>
    inviteEnvelope(await invite(actor, eventId, body).expect(201), 'POST /api/events/:eventId/invites').invite;

  const listInvites = (actor: AuthenticatedActor, eventId: string, query: Record<string, string> = {}) =>
    request(baseUrl).get(invitesPath(eventId)).query(query).set(actor.headers);

  const revoke = (actor: AuthenticatedActor, eventId: string, inviteId: string) =>
    request(baseUrl)
      .post(`${invitesPath(eventId)}/${inviteId}/revoke`)
      .set(actor.headers);

  const deleteEvent = (actor: AuthenticatedActor, eventId: string) =>
    request(baseUrl).delete(`${EVENTS_PATH}/${eventId}`).set(actor.headers);

  /** Seats `actor` on the event with `role`, as an accepted invite or a direct add leaves them. */
  const seat = (eventId: string, actor: SessionActor, role: SystemRole) =>
    db.client.eventAttendee.create({
      data: {
        event: { connect: { id: eventId } },
        user: { connect: { id: actor.user.id } },
        role: { create: { role: { connect: { name: role } } } },
      },
    });

  const storedInvite = (id: string) => db.client.invite.findUniqueOrThrow({ where: { id } });

  const attendeeRows = (eventId: string, actor: SessionActor) =>
    db.client.eventAttendee.count({ where: { eventId, userId: actor.user.id } });

  const invitesTo = (eventId: string) => db.client.invite.count({ where: { eventId } });

  /** An event `host` created, with a participant seated on it before either sends another request. */
  const eventWithParticipant = async (policy: Record<string, unknown> = {}) => {
    const [host, participant] = await Promise.all([actors.user(), actors.user()]);
    const eventId = await createdEventId(host, { policy });
    await seat(eventId, participant, SystemRole.EventParticipant);

    return { host, participant, eventId };
  };

  it('the host invites, and the invitee gets no attendee row or event role until they accept', async () => {
    const [host, invitee] = await Promise.all([actors.user(), actors.user()]);
    const eventId = await createdEventId(host);

    const sent = await sentInvite(host, eventId, { userId: invitee.user.id, message: 'Come play' });

    expect(sent).toMatchObject({
      type: InviteType.Event,
      status: InviteStatus.Pending,
      role: { name: SystemRole.EventParticipant },
      inviter: { id: host.user.id },
      message: 'Come play',
    });
    expect(await storedInvite(sent.id)).toMatchObject({ eventId, inviteeId: invitee.user.id, householdId: null });
    expect(await attendeeRows(eventId, invitee)).toBe(0);
    expect(
      await db.client.eventAttendeeRole.count({ where: { eventAttendee: { eventId, userId: invitee.user.id } } }),
    ).toBe(0);
  });

  it('a participant invites while allowMemberInvites is on', async () => {
    const { participant, eventId } = await eventWithParticipant();
    const invitee = await actors.user();

    const sent = await sentInvite(participant, eventId, { userId: invitee.user.id });

    expect(sent.inviter.id).toBe(participant.user.id);
  });

  it('with allowMemberInvites off, a participant gets 403 MEMBER_INVITES_OFF while the host still gets 201', async () => {
    const { host, participant, eventId } = await eventWithParticipant({ allowMemberInvites: false });
    const invitee = await actors.user();

    const refused = await invite(participant, eventId, { userId: invitee.user.id }).expect(403);

    expect(refused.body).toMatchObject({ code: MEMBER_INVITES_OFF, message: expect.any(String) });
    expect(await invitesTo(eventId)).toBe(0);

    await sentInvite(host, eventId, { userId: invitee.user.id });
  });

  it('with allowMemberInvites off, a household admin seated as a participant still invites, and a household member seated the same way is refused (#742)', async () => {
    const [owner, admin, member, invitee] = await Promise.all([
      actors.user(),
      actors.user(),
      actors.user(),
      actors.user(),
    ]);
    const { household } = await actors.householdWithMembers({
      owner,
      members: [
        { actor: admin, role: SystemRole.HouseholdAdmin },
        { actor: member, role: SystemRole.HouseholdMember },
      ],
    });
    const eventId = await createdEventId(owner, { householdId: household.id, policy: { allowMemberInvites: false } });
    await seat(eventId, admin, SystemRole.EventParticipant);
    await seat(eventId, member, SystemRole.EventParticipant);

    // The control: the same seat and policy without a household grant is the
    // refusal the switch exists for, so the 201 below is not vacuous.
    const refused = await invite(member, eventId, { userId: invitee.user.id }).expect(403);

    expect(refused.body).toMatchObject({ code: MEMBER_INVITES_OFF });
    expect(await invitesTo(eventId)).toBe(0);

    const sent = await sentInvite(admin, eventId, { userId: invitee.user.id });

    expect(sent.inviter.id).toBe(admin.user.id);
    expect(await invitesTo(eventId)).toBe(1);
  });

  it('a participant offering co-host gets 403, and no invite is written', async () => {
    const { participant, eventId } = await eventWithParticipant();
    const invitee = await actors.user();

    const refused = await invite(participant, eventId, {
      userId: invitee.user.id,
      role: SystemRole.EventCoHost,
    }).expect(403);

    expect(refused.body.code).not.toBe(MEMBER_INVITES_OFF);
    expect(await invitesTo(eventId)).toBe(0);
  });

  it('the host offers co-host, and the invite carries the role', async () => {
    const [host, invitee] = await Promise.all([actors.user(), actors.user()]);
    const eventId = await createdEventId(host);

    const sent = await sentInvite(host, eventId, { userId: invitee.user.id, role: SystemRole.EventCoHost });

    expect(sent.role).toMatchObject({ name: SystemRole.EventCoHost });
  });

  it('someone who is not on the event gets 403, and learns nothing about the invitee', async () => {
    const [host, stranger] = await Promise.all([actors.user(), actors.user()]);
    const eventId = await createdEventId(host);

    // An id that names nobody answers as one that names someone: the
    // stranger's grant is asked first.
    await invite(stranger, eventId, { userId: host.user.id }).expect(403);
    await invite(stranger, eventId, { userId: 'no-such-user' }).expect(403);
  });

  it('inviting someone already attending gets 409', async () => {
    const { host, participant, eventId } = await eventWithParticipant();

    const refused = await invite(host, eventId, { userId: participant.user.id }).expect(409);

    expect(refused.body.message).toBe('User is already an attendee of this event.');
    expect(await invitesTo(eventId)).toBe(0);
  });

  it('a blocked invitee gets 403, as placing them on an event answers', async () => {
    const [host, invitee] = await Promise.all([actors.user(), actors.user()]);
    await db.client.friendship.create({
      data: {
        requesterId: invitee.user.id,
        addresseeId: host.user.id,
        pairKey: [invitee.user.id, host.user.id].sort().join(':'),
        status: FriendshipStatus.Blocked,
        respondedAt: new Date(),
      },
    });
    const eventId = await createdEventId(host);

    const refused = await invite(host, eventId, { userId: invitee.user.id }).expect(403);

    expect(refused.body.message).toBe('You cannot place this user on an event');
    expect(await invitesTo(eventId)).toBe(0);
  });

  it('a second invite to the same person gets 409 while the first is open', async () => {
    const [host, invitee] = await Promise.all([actors.user(), actors.user()]);
    const eventId = await createdEventId(host);
    await sentInvite(host, eventId, { userId: invitee.user.id });

    await invite(host, eventId, { userId: invitee.user.id }).expect(409);

    expect(await invitesTo(eventId)).toBe(1);
  });

  it('the host lists the invites, and a participant gets 403', async () => {
    const { host, participant, eventId } = await eventWithParticipant();
    const [first, second] = await Promise.all([actors.user(), actors.user()]);
    const older = await sentInvite(host, eventId, { userId: first.user.id, message: 'For the invitee' });
    const newer = await sentInvite(participant, eventId, { userId: second.user.id });

    const { invites, pagination } = inviteListEnvelope(
      await listInvites(host, eventId).expect(200),
      'GET /api/events/:eventId/invites',
    );

    expect(invites.map((row) => row.id)).toEqual([newer.id, older.id]);
    expect(pagination.total).toBe(2);
    // The message is addressed to the invitee, never to the event's hosts.
    expect(invites[1]).not.toHaveProperty('message');
    expect(invites[1]).toMatchObject({ inviteeName: expect.any(String) });

    await listInvites(participant, eventId).expect(403);
  });

  it('the host revokes a participant’s invite, and may not revoke their own', async () => {
    const { host, participant, eventId } = await eventWithParticipant();
    const [first, second] = await Promise.all([actors.user(), actors.user()]);
    const theirs = await sentInvite(participant, eventId, { userId: first.user.id });
    const own = await sentInvite(host, eventId, { userId: second.user.id });

    const { invite: revoked } = revokeEnvelope(
      await revoke(host, eventId, theirs.id).expect(200),
      'POST /api/events/:eventId/invites/:inviteId/revoke',
    );

    expect(revoked).toMatchObject({ id: theirs.id, status: InviteStatus.Revoked });
    expect((await storedInvite(theirs.id)).status).toBe(InviteStatus.Revoked);
    // The inviter withdraws their own invite instead.
    await revoke(host, eventId, own.id).expect(403);
    await revoke(participant, eventId, own.id).expect(403);
    expect((await storedInvite(own.id)).status).toBe(InviteStatus.Pending);
  });

  it('an event invite id on a household revoke route gets 404', async () => {
    const host = await actors.user();
    const { household } = await actors.householdWithMembers({ owner: host });
    const { participant, eventId } = await eventWithParticipant();
    const invitee = await actors.user();
    const sent = await sentInvite(participant, eventId, { userId: invitee.user.id });

    await request(baseUrl)
      .post(`/api/households/${household.id}/invites/${sent.id}/revoke`)
      .set(host.headers)
      .expect(404);

    expect((await storedInvite(sent.id)).status).toBe(InviteStatus.Pending);
  });

  it('deleting an event revokes its open invites', async () => {
    const [host, first, second] = await Promise.all([actors.user(), actors.user(), actors.user()]);
    const eventId = await createdEventId(host);
    const open = await sentInvite(host, eventId, { userId: first.user.id });
    const declined = await sentInvite(host, eventId, { userId: second.user.id });
    await db.client.invite.update({ where: { id: declined.id }, data: { status: InviteStatus.Declined } });

    await deleteEvent(host, eventId).expect(200);

    expect((await storedInvite(open.id)).status).toBe(InviteStatus.Revoked);
    // A settled invite keeps its answer.
    expect((await storedInvite(declined.id)).status).toBe(InviteStatus.Declined);
  });

  it('a sixth invite past a cap of five is refused with 402, and writes nothing', async () => {
    const host = await actors.user();
    const invitees = await Promise.all(Array.from({ length: 6 }, () => actors.user()));
    await db.client.quota.create({
      data: {
        scope: QuotaScope.User,
        scopeId: host.user.id,
        resource: 'event_invite_daily_count',
        limit: 5n,
        householdId: null,
      },
    });
    const eventId = await createdEventId(host);

    for (const invitee of invitees.slice(0, 5)) {
      await sentInvite(host, eventId, { userId: invitee.user.id });
    }

    const refused = await invite(host, eventId, { userId: invitees[5].user.id }).expect(402);

    expect(refused.body).toMatchObject({
      resource: 'event_invite_daily_count',
      scope: QuotaScope.User,
      limit: '5',
      currentUsage: '5',
      attemptedAmount: '1',
    });
    expect(await invitesTo(eventId)).toBe(5);
  });
});
