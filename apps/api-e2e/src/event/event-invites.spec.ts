import {
  EventParticipationStatus,
  FriendshipStatus,
  GameAdditionMode,
  InviteStatus,
  InviteType,
  NominationStatus,
  QuotaScope,
  SystemRole,
} from '@bge/database';
import type { Actors, AuthenticatedActor, SessionActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import request from 'supertest';
import { inviteEnvelope, inviteListEnvelope, revokeEnvelope } from '../household/household-invite-wire';
import { mintApiKey } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { arrangeListEntry, hoursFromNow } from './event-fixtures';
import { partyInvitesEnvelope } from './event-invite-wire';
import { createEventInviteClient, PARTY_INVITES_PATH } from './event-join';
import { createEventClient, eventPolicyPath, EVENTS_PATH } from './event-request';
import { availabilitySummaryEnvelope, eventDetailEnvelope, nominationEnvelope } from './event-wire';

/** `allowMemberInvites` off refuses a participant with this code (#742). */
const MEMBER_INVITES_OFF = 'MEMBER_INVITES_OFF';

/** A settled invite answers an accept with this code, and the status it settled in (#1513). */
const INVITE_NOT_OUTSTANDING = 'INVITE_NOT_OUTSTANDING';

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

  const {
    invite,
    sentInvite,
    listInvites,
    revoke,
    accept: acceptInvite,
    accepted,
    decline: declineInvite,
    withdraw: withdrawInvite,
  } = createEventInviteClient(baseUrl);

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

  /** The ids of a party list's rows, in the order served: the inbox, or with `sent` the sent list. */
  const listedIds = async (actor: AuthenticatedActor, list: '' | '/sent', query: Record<string, string> = {}) =>
    partyInvitesEnvelope(
      await request(baseUrl).get(`${PARTY_INVITES_PATH}${list}`).query(query).set(actor.headers).expect(200),
      `GET /api/invites${list}`,
    ).invites.map((row) => row.id);

  const readEvent = (actor: AuthenticatedActor, eventId: string) =>
    request(baseUrl).get(`${EVENTS_PATH}/${eventId}`).set(actor.headers);

  const removeAttendee = (actor: AuthenticatedActor, eventId: string, attendeeId: string) =>
    request(baseUrl).delete(`${EVENTS_PATH}/${eventId}/attendees/${attendeeId}`).set(actor.headers);

  const attendeeRowOf = (eventId: string, actor: SessionActor) =>
    db.client.eventAttendee.findUniqueOrThrow({
      where: { eventId_userId: { eventId, userId: actor.user.id } },
      include: { role: { include: { role: true } } },
    });

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

    expect(refused.body.message).toBe("You can't invite this person to this event.");
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

  it('a sixth invite past a daily invite quota of five is refused with 402, and writes nothing', async () => {
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

  // The invitee answers at the party routes, which hand an event invite to the
  // event's responder (#742). Accepting is what seats them.
  describe('answering through /invites', () => {
    it('accepting writes the attendee row with the invite’s role, attending, invited by the host (#742)', async () => {
      const [host, invitee] = await Promise.all([actors.user(), actors.user()]);
      const eventId = await createdEventId(host);
      const sent = await sentInvite(host, eventId, { userId: invitee.user.id, role: SystemRole.EventCoHost });

      const answer = await accepted(invitee, sent.id);

      expect(answer.type).toBe(InviteType.Event);
      expect(answer.message).toBe('Invite accepted; you are now attending the event');
      expect(answer.invite).toMatchObject({ id: sent.id, type: InviteType.Event, status: InviteStatus.Accepted });
      expect(answer.attendee).toMatchObject({
        eventId,
        userId: invitee.user.id,
        status: EventParticipationStatus.Attending,
        removedAt: null,
        role: { role: { name: SystemRole.EventCoHost } },
      });

      const [row, hostRow] = await Promise.all([attendeeRowOf(eventId, invitee), attendeeRowOf(eventId, host)]);
      expect(row.id).toBe(answer.attendee.id);
      expect(row.status).toBe(EventParticipationStatus.Attending);
      expect(row.rsvpDate).toBeInstanceOf(Date);
      expect(row.role?.role.name).toBe(SystemRole.EventCoHost);
      expect(row.invitedById).toBe(hostRow.id);
      expect((await storedInvite(sent.id)).status).toBe(InviteStatus.Accepted);

      // The co-host role holds from their very next request: their cached
      // ability was evicted after the accept committed.
      await listInvites(invitee, eventId).expect(200);
    });

    it('the invitee reads the event before accepting, with its dates and policy and no attendees (#742)', async () => {
      const [host, invitee] = await Promise.all([actors.user(), actors.user()]);
      const eventId = await createdEventId(host, {
        occurrences: [{ startDate: hoursFromNow(48) }],
        policy: { allowMemberInvites: true },
      });
      await sentInvite(host, eventId, { userId: invitee.user.id });

      const event = eventDetailEnvelope(
        await readEvent(invitee, eventId).expect(200),
        'GET /api/events/:id as the invitee',
      );

      expect(event.id).toBe(eventId);
      // Who attends shows once they accept.
      expect(event.attendees).toEqual([]);
      expect(event.attendance).toBeNull();
      // The dates and the policy, so the client can show its own event screen.
      expect(event.occurrences).toHaveLength(1);
      expect(event.policy).toMatchObject({ allowMemberInvites: true });
    });

    it('a stranger can’t read it (#742)', async () => {
      const [host, invitee, stranger] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      const eventId = await createdEventId(host);
      await sentInvite(host, eventId, { userId: invitee.user.id });

      await readEvent(stranger, eventId).expect(404);
    });

    it('revives a removed attendee’s row on accept, and the nominations of the games they offer reopen (#742, #551)', async () => {
      const [host, invitee] = await Promise.all([actors.user(), actors.user()]);
      const eventId = await createdEventId(host, { policy: { gameAdditionMode: GameAdditionMode.RequiresVote } });
      const { id: rowId } = await db.client.eventAttendee.create({
        data: {
          event: { connect: { id: eventId } },
          user: { connect: { id: invitee.user.id } },
          status: EventParticipationStatus.Attending,
          role: { create: { role: { connect: { name: SystemRole.EventParticipant } } } },
        },
        select: { id: true },
      });
      const entry = await arrangeListEntry(db.client, eventId, invitee.user.id);
      const nomination = nominationEnvelope(
        await request(baseUrl)
          .post(`${EVENTS_PATH}/${eventId}/nominations`)
          .set(host.headers)
          .send({ platformGameId: entry.platformGameId, suppliedFromId: entry.suppliedById })
          .expect(201),
        'POST /api/events/:eventId/nominations',
      );
      const nominationStatus = async () =>
        (await db.client.eventGameNomination.findUniqueOrThrow({ where: { id: nomination.id } })).status;

      await removeAttendee(host, eventId, rowId).expect(200);
      expect(await nominationStatus()).toBe(NominationStatus.Paused);

      const sent = await sentInvite(host, eventId, { userId: invitee.user.id, role: SystemRole.EventSpectator });
      const { attendee } = await accepted(invitee, sent.id);

      // The same row, not a second one beside it.
      expect(attendee.id).toBe(rowId);
      expect(await attendeeRows(eventId, invitee)).toBe(1);
      const row = await attendeeRowOf(eventId, invitee);
      expect(row.removedAt).toBeNull();
      expect(row.status).toBe(EventParticipationStatus.Attending);
      expect(row.role?.role.name).toBe(SystemRole.EventSpectator);
      expect(await nominationStatus()).toBe(NominationStatus.Open);
    });

    it('accept after the event is deleted writes nothing: 404, the invite left revoked (#742)', async () => {
      const [host, invitee] = await Promise.all([actors.user(), actors.user()]);
      const eventId = await createdEventId(host);
      const sent = await sentInvite(host, eventId, { userId: invitee.user.id });
      await deleteEvent(host, eventId).expect(200);

      await acceptInvite(invitee, sent.id).expect(404);

      expect((await storedInvite(sent.id)).status).toBe(InviteStatus.Revoked);
      expect(await attendeeRows(eventId, invitee)).toBe(0);
    });

    // A household's delete stamps only the household, so the invite to its
    // event stays Pending; the lists and the accept read the event as gone
    // through the household's liveness (#742).
    it('an invite to a household event is hidden from both lists, and its accept answers 404, once the household is deleted (#742)', async () => {
      const [owner, invitee] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner, members: [] });
      const eventId = await createdEventId(owner, { householdId: household.id });
      const sent = await sentInvite(owner, eventId, { userId: invitee.user.id });

      // The control: both lists carry the invite while the household is live.
      expect(await listedIds(invitee, '')).toEqual([sent.id]);
      expect(await listedIds(owner, '/sent')).toEqual([sent.id]);

      await request(baseUrl).delete(`/api/households/${household.id}`).set(owner.headers).expect(200);

      expect(await listedIds(invitee, '')).toEqual([]);
      expect(await listedIds(owner, '/sent')).toEqual([]);

      await acceptInvite(invitee, sent.id).expect(404);

      expect(await attendeeRows(eventId, invitee)).toBe(0);
    });

    it('an inviter who was removed leaves their invite revoked, and its accept answers 409 (#742)', async () => {
      const { host, participant, eventId } = await eventWithParticipant();
      const invitee = await actors.user();
      const sent = await sentInvite(participant, eventId, { userId: invitee.user.id });
      const { id: participantRowId } = await attendeeRowOf(eventId, participant);

      await removeAttendee(host, eventId, participantRowId).expect(200);

      expect((await storedInvite(sent.id)).status).toBe(InviteStatus.Revoked);
      expect(await listedIds(invitee, '')).toEqual([]);

      const refused = await acceptInvite(invitee, sent.id).expect(409);

      expect(refused.body).toMatchObject({ code: INVITE_NOT_OUTSTANDING, state: InviteStatus.Revoked });
      expect(await attendeeRows(eventId, invitee)).toBe(0);
    });

    it('an invite its sender could no longer send is revoked at accept, and answers 409 (#742)', async () => {
      const { host, participant, eventId } = await eventWithParticipant();
      const invitee = await actors.user();
      const sent = await sentInvite(participant, eventId, { userId: invitee.user.id });

      // Sent as a participant while the policy let them; it doesn't now.
      await request(baseUrl)
        .patch(eventPolicyPath(eventId))
        .set(host.headers)
        .send({ allowMemberInvites: false })
        .expect(200);

      const refused = await acceptInvite(invitee, sent.id).expect(409);

      expect(refused.body).toMatchObject({ code: INVITE_NOT_OUTSTANDING, state: InviteStatus.Revoked });
      expect((await storedInvite(sent.id)).status).toBe(InviteStatus.Revoked);
      expect(await attendeeRows(eventId, invitee)).toBe(0);
    });

    it('someone already attending gets 409 on accept, and the invite stays open (#742)', async () => {
      const [host, invitee] = await Promise.all([actors.user(), actors.user()]);
      const eventId = await createdEventId(host);
      const sent = await sentInvite(host, eventId, { userId: invitee.user.id });
      await seat(eventId, invitee, SystemRole.EventParticipant);

      const refused = await acceptInvite(invitee, sent.id).expect(409);

      expect(refused.body.message).toBe('User is already an attendee of this event.');
      expect((await storedInvite(sent.id)).status).toBe(InviteStatus.Pending);
      expect(await attendeeRows(eventId, invitee)).toBe(1);
    });

    it('decline, and withdraw by the inviter, through /invites (#742)', async () => {
      const [host, first, second] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      const eventId = await createdEventId(host);
      const toDecline = await sentInvite(host, eventId, { userId: first.user.id });
      const toWithdraw = await sentInvite(host, eventId, { userId: second.user.id });

      // Each party answers only their own side of it.
      await declineInvite(host, toDecline.id).expect(403);
      await withdrawInvite(second, toWithdraw.id).expect(403);

      const declined = inviteEnvelope(
        await declineInvite(first, toDecline.id).expect(200),
        'POST /api/invites/:inviteId/decline',
      );
      const withdrawn = inviteEnvelope(
        await withdrawInvite(host, toWithdraw.id).expect(200),
        'POST /api/invites/:inviteId/withdraw',
      );

      expect(declined).toMatchObject({
        message: 'Invite declined',
        invite: { id: toDecline.id, type: InviteType.Event, status: InviteStatus.Declined },
      });
      expect(withdrawn).toMatchObject({
        message: 'Invite withdrawn',
        invite: { id: toWithdraw.id, type: InviteType.Event, status: InviteStatus.Withdrawn },
      });
      expect((await storedInvite(toDecline.id)).status).toBe(InviteStatus.Declined);
      expect((await storedInvite(toWithdraw.id)).status).toBe(InviteStatus.Withdrawn);
      // The event's read ends with the open invite that gave it.
      await readEvent(first, eventId).expect(404);
      await readEvent(second, eventId).expect(404);
      expect(await attendeeRows(eventId, first)).toBe(0);
    });

    it('routes by type: each list carries the event invite as an event row, and ?type= keeps one kind (#742)', async () => {
      const [owner, host, invitee] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner });
      const householdInvite = inviteEnvelope(
        await request(baseUrl)
          .post(`/api/households/${household.id}/invites`)
          .set(owner.headers)
          .send({ inviteeId: invitee.user.id })
          .expect(201),
        'POST /api/households/:householdId/invites',
      ).invite;
      const eventId = await createdEventId(host);
      const eventInvite = await sentInvite(host, eventId, { userId: invitee.user.id });
      const { title } = await db.client.event.findUniqueOrThrow({ where: { id: eventId }, select: { title: true } });

      const inbox = partyInvitesEnvelope(
        await request(baseUrl).get(PARTY_INVITES_PATH).set(invitee.headers).expect(200),
        'GET /api/invites',
      );

      // Newest first, both kinds, each naming its own context.
      expect(inbox.invites.map((row) => row.id)).toEqual([eventInvite.id, householdInvite.id]);
      expect(inbox.invites[0]).toMatchObject({
        type: InviteType.Event,
        event: { id: eventId, title },
        household: null,
      });
      expect(await listedIds(invitee, '', { type: InviteType.Household })).toEqual([householdInvite.id]);
      expect(await listedIds(invitee, '', { type: InviteType.Event })).toEqual([eventInvite.id]);

      const sent = partyInvitesEnvelope(
        await request(baseUrl).get(`${PARTY_INVITES_PATH}/sent`).set(host.headers).expect(200),
        'GET /api/invites/sent',
      );

      expect(sent.invites).toEqual([
        expect.objectContaining({ id: eventInvite.id, type: InviteType.Event, event: { id: eventId, title } }),
      ]);
      expect(await listedIds(host, '/sent', { type: InviteType.Household })).toEqual([]);
      expect(await listedIds(host, '/sent', { type: InviteType.Event })).toEqual([eventInvite.id]);
    });

    it('an API key can’t accept: the invite stays open and nobody is seated (#742)', async () => {
      const [host, invitee] = await Promise.all([actors.user(), actors.user()]);
      const eventId = await createdEventId(host);
      const sent = await sentInvite(host, eventId, { userId: invitee.user.id });
      const key = await mintApiKey(baseUrl, db.client, invitee);

      await acceptInvite(key, sent.id).expect(403);

      expect((await storedInvite(sent.id)).status).toBe(InviteStatus.Pending);
      expect(await attendeeRows(eventId, invitee)).toBe(0);
    });

    it('an invitee isn’t counted in the availability poll until they accept (#742)', async () => {
      const [host, invitee] = await Promise.all([actors.user(), actors.user()]);
      const eventId = await createdEventId(host, { occurrences: [{ startDate: hoursFromNow(48) }] });
      const sent = await sentInvite(host, eventId, { userId: invitee.user.id });

      const eligibleVoters = async () =>
        availabilitySummaryEnvelope(
          await request(baseUrl)
            .get(`${EVENTS_PATH}/${eventId}/occurrences/summary/availability`)
            .set(host.headers)
            .expect(200),
          'GET /api/events/:eventId/occurrences/summary/availability',
        ).eligibleVoters;

      const before = await eligibleVoters();
      await accepted(invitee, sent.id);

      expect(await eligibleVoters()).toBe(before + 1);
    });
  });
});
