import {
  AvailabilityResponse,
  EventParticipationStatus,
  NominationStatus,
  OccurrenceStatus,
  SystemRole,
  VoteType,
} from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { arrangeListEntry } from './event-fixtures';
import { createEventClient, EVENTS_PATH } from './event-request';
import { attendeeEnvelope, eventEnvelope, eventGameEnvelope, occurrenceEnvelope } from './event-wire';

/**
 * Who may write what on an event, over the real routes (#454, #539, #457, #458,
 * #558).
 *
 * Each route's policy check judges its action by type alone, so it passes
 * any actor holding the grant on ANY event or household; the service binds it
 * to the row being written. Every denial below sits beside a control showing
 * the same actor, or the same request, succeeding where it should, so a
 * denial cannot pass because the route refused everyone or the actor held no
 * grant at all.
 *
 * Events are created through `POST /api/events`, not arranged in the
 * database: the creator becoming the event's host is part of what is under
 * test, and so is that host being able to act on the event in their very next
 * request.
 */
describe('event write authorization', () => {
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

  const { createEvent, createdEventId } = createEventClient(baseUrl);

  const updateEvent = (actor: AuthenticatedActor, eventId: string, body: Record<string, unknown>) =>
    request(baseUrl).patch(`${EVENTS_PATH}/${eventId}`).set(actor.headers).send(body);

  const addAttendee = (actor: AuthenticatedActor, eventId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(`${EVENTS_PATH}/${eventId}/attendees`).set(actor.headers).send(body);

  const removeAttendee = (actor: AuthenticatedActor, eventId: string, attendeeId: string) =>
    request(baseUrl).delete(`${EVENTS_PATH}/${eventId}/attendees/${attendeeId}`).set(actor.headers);

  const directAdd = (actor: AuthenticatedActor, eventId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(`${EVENTS_PATH}/${eventId}/nominations/direct-add`).set(actor.headers).send(body);

  const castVote = (actor: AuthenticatedActor, eventId: string, nominationId: string) =>
    request(baseUrl)
      .post(`${EVENTS_PATH}/${eventId}/nominations/${nominationId}/votes`)
      .set(actor.headers)
      .send({ voteType: VoteType.For });

  const submitAvailability = (actor: AuthenticatedActor, eventId: string, occurrenceId: string) =>
    request(baseUrl)
      .post(`${EVENTS_PATH}/${eventId}/occurrences/${occurrenceId}/availability`)
      .set(actor.headers)
      .send({ response: AvailabilityResponse.Available });

  const updateStatus = (actor: AuthenticatedActor, eventId: string, attendeeId: string) =>
    request(baseUrl)
      .patch(`${EVENTS_PATH}/${eventId}/attendees/${attendeeId}/status`)
      .set(actor.headers)
      .send({ status: EventParticipationStatus.Attending });

  const withdraw = (actor: AuthenticatedActor, eventId: string, nominationId: string) =>
    request(baseUrl).patch(`${EVENTS_PATH}/${eventId}/nominations/${nominationId}/withdraw`).set(actor.headers);

  const addedOccurrenceId = async (actor: AuthenticatedActor, eventId: string) =>
    occurrenceEnvelope(
      await request(baseUrl)
        .post(`${EVENTS_PATH}/${eventId}/occurrences`)
        .set(actor.headers)
        .send({ label: 'Saturday' })
        .expect(201),
      'POST /api/events/:eventId/occurrences',
    ).id;

  const removeOccurrence = (actor: AuthenticatedActor, eventId: string, occurrenceId: string) =>
    request(baseUrl).delete(`${EVENTS_PATH}/${eventId}/occurrences/${occurrenceId}`).set(actor.headers);

  const attendeeCount = (eventId: string) => db.client.eventAttendee.count({ where: { eventId } });

  const attendeeRowId = async (eventId: string, userId: string) =>
    (
      await db.client.eventAttendee.findUniqueOrThrow({
        where: { eventId_userId: { eventId, userId } },
        select: { id: true },
      })
    ).id;

  const householdEventCount = (householdId: string) => db.client.event.count({ where: { householdId } });

  const MANAGING_ROLES = [SystemRole.EventCoHost, SystemRole.EventOrganizer, SystemRole.EventModerator] as const;

  describe('attaching an event to a household (#454)', () => {
    it('lets a member create an event in their household, and any user create one outside every household', async () => {
      const owner = await actors.user();
      const member = await actors.user();
      const outsider = await actors.user();
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
      });

      const created = eventEnvelope(
        await createEvent(member, { householdId: household.id }).expect(201),
        'POST /api/events as a household member',
      );
      expect(created.householdId).toBe(household.id);

      const personal = eventEnvelope(await createEvent(outsider).expect(201), 'POST /api/events outside a household');
      expect(personal.householdId).toBeNull();
    });

    it('refuses an event attached to a household the creator is not in, and writes nothing', async () => {
      const owner = await actors.user();
      const outsider = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });

      // Control: the outsider can create events, so the refusal below is
      // about the household and not about creating events at all.
      await createEvent(outsider).expect(201);

      await createEvent(outsider, { householdId: household.id }).expect(403);
      expect(await householdEventCount(household.id)).toBe(0);
    });

    it('refuses a household guest an event attached to the household it visits', async () => {
      const owner = await actors.user();
      const guest = await actors.user();
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: guest, role: SystemRole.HouseholdGuest }],
      });

      await createEvent(guest, { householdId: household.id }).expect(403);
      await createEvent(owner, { householdId: household.id }).expect(201);
      expect(await householdEventCount(household.id)).toBe(1);
    });

    it('refuses its own owner an event attached to a soft-deleted household', async () => {
      const owner = await actors.user();
      const { household: deleted } = await actors.householdWithMembers({ owner, name: 'e2e deleted household' });
      const { household: live } = await actors.householdWithMembers({ owner, name: 'e2e live household' });
      // Before the owner's first request, so the graph that request builds
      // already excludes the household.
      await db.client.household.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });

      // Control: the same owner, attaching to a household that still exists.
      await createEvent(owner, { householdId: live.id }).expect(201);

      await createEvent(owner, { householdId: deleted.id }).expect(403);
      expect(await householdEventCount(deleted.id)).toBe(0);
    });

    it("refuses an event attached to a household soft-deleted after the creator's graph was cached", async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });

      // Control: the owner creates an event there while it is live.
      await createEvent(owner, { householdId: household.id }).expect(201);

      // That create evicted the owner's graph, so this request caches a fresh
      // one that still holds the household role. The soft-delete skips the
      // delete route and its eviction, as a delete committing after the graph
      // was built does, or an eviction that failed.
      await request(baseUrl).get(EVENTS_PATH).set(owner.headers).expect(200);
      await db.client.household.update({ where: { id: household.id }, data: { deletedAt: new Date() } });

      // 404 rather than 403: the cached grant still passes the check, and the
      // write is what finds the household dead.
      await createEvent(owner, { householdId: household.id }).expect(404);
      expect(await householdEventCount(household.id)).toBe(1);
    });

    it("answers the site's Owner 404 for a soft-deleted or unknown household, and writes nothing", async () => {
      const siteOwner = await actors.owner();
      const { household: live } = await actors.householdWithMembers({
        owner: await actors.user(),
        name: 'e2e live household',
      });
      const { household: deleted } = await actors.householdWithMembers({
        owner: await actors.user(),
        name: 'e2e deleted household',
      });
      await db.client.household.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });

      // Control: the Owner's grant reaches a household they hold no role in,
      // so the refusals below come from the household and not the grant.
      await createEvent(siteOwner, { householdId: live.id }).expect(201);

      await createEvent(siteOwner, { householdId: deleted.id }).expect(404);
      await createEvent(siteOwner, { householdId: randomUUID() }).expect(404);
      expect(await householdEventCount(deleted.id)).toBe(0);
    });

    it("answers 400 to a PATCH naming a household, and leaves the event's household as it was", async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const { household: other } = await actors.householdWithMembers({ owner: await actors.user() });
      const eventId = await createdEventId(owner, { householdId: household.id });

      // Control: the owner can PATCH this event.
      await updateEvent(owner, eventId, { title: 'Renamed' }).expect(200);

      await updateEvent(owner, eventId, { householdId: null }).expect(400);
      await updateEvent(owner, eventId, { householdId: other.id }).expect(400);

      const row = await db.client.event.findUniqueOrThrow({ where: { id: eventId }, select: { householdId: true } });
      expect(row.householdId).toBe(household.id);
    });
  });

  describe('adding an attendee (#539)', () => {
    it('lets a host manage the attendees of an event they have just created', async () => {
      // The host's graph is built and cached by the create request itself,
      // before the host row exists. The create has to evict it, or this add
      // is refused until the cache expires.
      const host = await actors.user();
      const guest = await actors.user();
      const eventId = await createdEventId(host);

      const added = attendeeEnvelope(
        await addAttendee(host, eventId, { userId: guest.user.id }).expect(201),
        'POST /api/events/:eventId/attendees as the new host',
      );
      expect(added.userId).toBe(guest.user.id);
    });

    it('refuses the host of one event any add to an event they hold no role on, themselves included', async () => {
      const victim = await actors.user();
      const attacker = await actors.user();
      const bystander = await actors.user();
      const targetId = await createdEventId(victim);
      const ownId = await createdEventId(attacker);

      // Control: the attacker holds the attendee grant, on their own event.
      await addAttendee(attacker, ownId, { userId: bystander.user.id }).expect(201);

      // The self-add as co-host is the escalation #539 reported. The
      // participant adds show the binding refuses every add, not only a
      // managing one.
      const before = await attendeeCount(targetId);
      await addAttendee(attacker, targetId, { userId: attacker.user.id }).expect(403);
      await addAttendee(attacker, targetId, { userId: attacker.user.id, role: SystemRole.EventCoHost }).expect(403);
      await addAttendee(attacker, targetId, { userId: bystander.user.id }).expect(403);
      expect(await attendeeCount(targetId)).toBe(before);
    });

    it.each([SystemRole.EventOrganizer, SystemRole.EventModerator])(
      'refuses an %s adding a co-host, organizer or moderator, and lets the host make the same adds',
      async (delegateRole) => {
        const host = await actors.user();
        const delegate = await actors.user();
        const other = await actors.user();
        const invitees = new Map<SystemRole, AuthenticatedActor>();
        for (const role of MANAGING_ROLES) {
          invitees.set(role, await actors.user());
        }
        const inviteeFor = (role: SystemRole) => invitees.get(role)?.user.id;

        const eventId = await createdEventId(host);
        await addAttendee(host, eventId, { userId: delegate.user.id, role: delegateRole }).expect(201);

        // Control: the delegate may add attendees here, in the roles that
        // attend the event rather than run it.
        await addAttendee(delegate, eventId, { userId: other.user.id, role: SystemRole.EventSpectator }).expect(201);

        const before = await attendeeCount(eventId);
        for (const role of MANAGING_ROLES) {
          await addAttendee(delegate, eventId, { userId: inviteeFor(role), role }).expect(403);
        }
        expect(await attendeeCount(eventId)).toBe(before);

        for (const role of MANAGING_ROLES) {
          await addAttendee(host, eventId, { userId: inviteeFor(role), role }).expect(201);
        }
      },
    );

    it.each([SystemRole.EventOrganizer, SystemRole.EventModerator])(
      'refuses an %s removing the host or a co-host, and lets it remove a spectator',
      async (delegateRole) => {
        const host = await actors.user();
        const delegate = await actors.user();
        const coHost = await actors.user();
        const spectator = await actors.user();
        const eventId = await createdEventId(host);
        await addAttendee(host, eventId, { userId: delegate.user.id, role: delegateRole }).expect(201);
        await addAttendee(host, eventId, { userId: coHost.user.id, role: SystemRole.EventCoHost }).expect(201);
        await addAttendee(host, eventId, { userId: spectator.user.id, role: SystemRole.EventSpectator }).expect(201);

        const before = await attendeeCount(eventId);
        await removeAttendee(delegate, eventId, await attendeeRowId(eventId, host.user.id)).expect(403);
        await removeAttendee(delegate, eventId, await attendeeRowId(eventId, coHost.user.id)).expect(403);
        expect(await attendeeCount(eventId)).toBe(before);

        // Control: the delegate may remove attendees here, in the roles
        // that attend the event rather than run it.
        await removeAttendee(delegate, eventId, await attendeeRowId(eventId, spectator.user.id)).expect(200);
        expect(await attendeeCount(eventId)).toBe(before - 1);
      },
    );

    it("lets the site's Owner give out a managing role on an event they hold no role on", async () => {
      // The Owner seat goes to the first human user, so it is minted first.
      const siteOwner = await actors.owner();
      const host = await actors.user();
      const invitee = await actors.user();
      const eventId = await createdEventId(host);

      const added = attendeeEnvelope(
        await addAttendee(siteOwner, eventId, { userId: invitee.user.id, role: SystemRole.EventCoHost }).expect(201),
        "POST /api/events/:eventId/attendees as the site's Owner",
      );
      expect(added.userId).toBe(invitee.user.id);
    });

    it('refuses a removed co-host on their very next request', async () => {
      // The co-host's own request caches a graph holding the role; the
      // removal has to evict it, or the co-host keeps co-hosting until the
      // cache expires.
      const host = await actors.user();
      const coHost = await actors.user();
      const first = await actors.user();
      const second = await actors.user();
      const eventId = await createdEventId(host);
      const coHostRow = attendeeEnvelope(
        await addAttendee(host, eventId, { userId: coHost.user.id, role: SystemRole.EventCoHost }).expect(201),
        'POST /api/events/:eventId/attendees as the host',
      );

      await addAttendee(coHost, eventId, { userId: first.user.id }).expect(201);

      await removeAttendee(host, eventId, coHostRow.id).expect(200);

      await addAttendee(coHost, eventId, { userId: second.user.id }).expect(403);
    });

    it("lets the household's owner add a co-host to its events without attending, and refuses another household's owner", async () => {
      const owner = await actors.user();
      const member = await actors.user();
      const otherOwner = await actors.user();
      const otherMember = await actors.user();
      const invitee = await actors.user();
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
      });
      const { household: otherHousehold } = await actors.householdWithMembers({
        owner: otherOwner,
        members: [{ actor: otherMember, role: SystemRole.HouseholdMember }],
      });
      const eventId = await createdEventId(member, { householdId: household.id });
      const otherEventId = await createdEventId(otherMember, { householdId: otherHousehold.id });

      // Control: the other owner manages attendees of their own household's
      // events, so the refusal after it is the household binding's.
      await addAttendee(otherOwner, otherEventId, { userId: invitee.user.id }).expect(201);
      await addAttendee(otherOwner, eventId, { userId: invitee.user.id }).expect(403);
      expect(await attendeeCount(eventId)).toBe(1);

      const added = attendeeEnvelope(
        await addAttendee(owner, eventId, { userId: invitee.user.id, role: SystemRole.EventCoHost }).expect(201),
        "POST /api/events/:eventId/attendees as the household's owner",
      );
      expect(added.userId).toBe(invitee.user.id);
    });
  });

  describe('adding a game directly (#457)', () => {
    it('refuses a supplier from another event or for another game, and writes nothing', async () => {
      const host = await actors.user();
      const stranger = await actors.user();
      const eventId = await createdEventId(host);
      const strangersEventId = await createdEventId(stranger);

      const own = await arrangeListEntry(db.client, eventId, host.user.id);
      const otherGame = await arrangeListEntry(db.client, eventId, host.user.id);
      const foreign = await arrangeListEntry(db.client, strangersEventId, stranger.user.id);

      await directAdd(host, eventId, {
        platformGameId: foreign.platformGameId,
        suppliedById: foreign.suppliedById,
      }).expect(404);
      await directAdd(host, eventId, {
        platformGameId: own.platformGameId,
        suppliedById: otherGame.suppliedById,
      }).expect(400);
      expect(await db.client.eventGame.count({ where: { eventId } })).toBe(0);

      // Control: the same host, with a supplier from this event for this game.
      const added = eventGameEnvelope(
        await directAdd(host, eventId, own).expect(201),
        'POST /api/events/:eventId/nominations/direct-add',
      );
      expect(added.suppliedById).toBe(own.suppliedById);
    });
  });

  describe('removing an occurrence (#558)', () => {
    it("refuses the host of one event the removal of another event's occurrence, and removes nothing", async () => {
      const host = await actors.user();
      const victim = await actors.user();
      const ownId = await createdEventId(host);
      const targetId = await createdEventId(victim);
      const ownOccurrence = await addedOccurrenceId(host, ownId);
      const targetOccurrence = await addedOccurrenceId(victim, targetId);

      await removeOccurrence(host, targetId, targetOccurrence).expect(403);
      expect(await db.client.eventOccurrence.count({ where: { id: targetOccurrence } })).toBe(1);

      // Control: the same host removes their own event's occurrence.
      await removeOccurrence(host, ownId, ownOccurrence).expect(200);
    });
  });

  describe("the actor's own attendee row (#458)", () => {
    /**
     * An attendee who attends one event as a spectator, which casts no vote,
     * updates no RSVP and withdraws no nomination, and another as a
     * participant, which does all three. An event role is rendered once per
     * attendance, so the participant's grants are in the attendee's graph
     * beside the spectator's, and each route's type-only check passes on them
     * in either event.
     */
    const arrangeAttendee = async () => {
      const spectatedHost = await actors.user();
      const participatedHost = await actors.user();
      const attendee = await actors.user();
      const spectatedId = await createdEventId(spectatedHost);
      const participatedId = await createdEventId(participatedHost);
      await addAttendee(spectatedHost, spectatedId, {
        userId: attendee.user.id,
        role: SystemRole.EventSpectator,
      }).expect(201);
      await addAttendee(participatedHost, participatedId, {
        userId: attendee.user.id,
        role: SystemRole.EventParticipant,
      }).expect(201);

      return { attendee, spectatedHost, spectatedId, participatedHost, participatedId };
    };

    /** An open nomination on `eventId`, made by `nominatorId` from their own list. */
    const arrangeNomination = async (eventId: string, nominatorId: string) => {
      const { platformGameId, suppliedById } = await arrangeListEntry(db.client, eventId, nominatorId);
      const nomination = await db.client.eventGameNomination.create({
        data: {
          eventId,
          platformGameId,
          nominatedById: await attendeeRowId(eventId, nominatorId),
          suppliedFromId: suppliedById,
          status: NominationStatus.Open,
        },
        select: { id: true },
      });

      return nomination.id;
    };

    /** A proposed occurrence on `eventId`, open for availability votes. */
    const arrangeProposedOccurrence = async (eventId: string) =>
      (
        await db.client.eventOccurrence.create({
          data: { eventId, status: OccurrenceStatus.Proposed },
          select: { id: true },
        })
      ).id;

    it('refuses a game vote from a spectator who participates in another event, and writes nothing', async () => {
      const { attendee, spectatedHost, spectatedId, participatedHost, participatedId } = await arrangeAttendee();
      const spectatedNomination = await arrangeNomination(spectatedId, spectatedHost.user.id);
      const participatedNomination = await arrangeNomination(participatedId, participatedHost.user.id);

      // Control: the attendee votes where they participate.
      await castVote(attendee, participatedId, participatedNomination).expect(201);

      await castVote(attendee, spectatedId, spectatedNomination).expect(403);
      expect(await db.client.eventGameVote.count({ where: { eventGameNominationId: spectatedNomination } })).toBe(0);
    });

    it('refuses availability from a spectator who participates in another event, and writes nothing', async () => {
      const { attendee, spectatedId, participatedId } = await arrangeAttendee();
      const spectatedOccurrence = await arrangeProposedOccurrence(spectatedId);
      const participatedOccurrence = await arrangeProposedOccurrence(participatedId);

      // Control: the attendee answers where they participate.
      await submitAvailability(attendee, participatedId, participatedOccurrence).expect(201);

      await submitAvailability(attendee, spectatedId, spectatedOccurrence).expect(403);
      expect(await db.client.eventAvailabilityVote.count({ where: { occurrenceId: spectatedOccurrence } })).toBe(0);
    });

    it('refuses an RSVP from a spectator who participates in another event, and leaves it as it was', async () => {
      const { attendee, spectatedId, participatedId } = await arrangeAttendee();
      const spectatedRow = await attendeeRowId(spectatedId, attendee.user.id);
      const participatedRow = await attendeeRowId(participatedId, attendee.user.id);

      // Control: the attendee RSVPs where they participate.
      await updateStatus(attendee, participatedId, participatedRow).expect(200);

      await updateStatus(attendee, spectatedId, spectatedRow).expect(403);
      expect(
        await db.client.eventAttendee.findUniqueOrThrow({
          where: { id: spectatedRow },
          select: { status: true, rsvpDate: true },
        }),
      ).toEqual({ status: EventParticipationStatus.Invited, rsvpDate: null });
    });

    it('refuses a spectator who participates in another event the withdrawal of their own nomination, and leaves it open', async () => {
      const { attendee, spectatedId, participatedId } = await arrangeAttendee();
      // Both nominations are the attendee's own, as a withdrawal demands; the
      // one where they spectate stands for a nomination made before a demotion.
      const spectatedNomination = await arrangeNomination(spectatedId, attendee.user.id);
      const participatedNomination = await arrangeNomination(participatedId, attendee.user.id);

      // Control: the attendee withdraws where they participate.
      await withdraw(attendee, participatedId, participatedNomination).expect(200);

      await withdraw(attendee, spectatedId, spectatedNomination).expect(403);
      expect(
        await db.client.eventGameNomination.findUniqueOrThrow({
          where: { id: spectatedNomination },
          select: { status: true },
        }),
      ).toEqual({ status: NominationStatus.Open });
    });
  });
});
