import {
  AvailabilityResponse,
  EventParticipationStatus,
  EventSchedulingMode,
  GameAdditionMode,
  NominationStatus,
  OccurrenceStatus,
  ResourceType,
  SystemRole,
  VoteType,
} from '@bge/database';
import type { Actors, AuthenticatedActor, SessionActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Caller } from '../support/api-key';
import { mintApiKey, mintApiKeyWithArrangedScopes } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { arrangeListEntry, hoursFromNow } from './event-fixtures';
import { createEventInviteClient, inviteAndAccept } from './event-join';
import { createEventClient, EVENTS_PATH } from './event-request';
import {
  attendeeEnvelope,
  eventEnvelope,
  eventGameEnvelope,
  nominationEnvelope,
  occurrenceEnvelope,
} from './event-wire';

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

  const updateEvent = (caller: Caller, eventId: string, body: Record<string, unknown>) =>
    request(baseUrl).patch(`${EVENTS_PATH}/${eventId}`).set(caller.headers).send(body);

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

  // Maybe by default, which none of these rows starts as: the host's row is Attending
  // from the event's creation, so a refused send that got through would
  // show (#1027).
  const updateStatus = (
    actor: AuthenticatedActor,
    eventId: string,
    attendeeId: string,
    status: EventParticipationStatus = EventParticipationStatus.Maybe,
  ) =>
    request(baseUrl)
      .patch(`${EVENTS_PATH}/${eventId}/attendees/${attendeeId}/status`)
      .set(actor.headers)
      .send({ status });

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

  // A removal keeps the row and marks it (#551), so the count is of the
  // attendees still on the event.
  const attendeeCount = (eventId: string) => db.client.eventAttendee.count({ where: { eventId, removedAt: null } });

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

  // The cancel and archive permissions are bound to the columns they write,
  // which a PATCH never sends. With no field in its checks, the PATCH passed
  // any update permission on Event, so a key scoped to only one of those,
  // whose owner hosts the event, edited the whole event (#1295).
  describe('editing an event through an API key (#1295)', () => {
    // Arranged: the route refuses an Event pin (#1418).
    const keyFor = (owner: SessionActor, eventId: string, slug: string) =>
      mintApiKeyWithArrangedScopes(baseUrl, db.client, owner, {
        slugs: [slug],
        resourceType: ResourceType.Event,
        resourceId: eventId,
      });

    const storedTitle = async (eventId: string) =>
      (await db.client.event.findUniqueOrThrow({ where: { id: eventId }, select: { title: true } })).title;

    it('lets a key holding update:event edit an event its owner hosts', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host);
      const key = await keyFor(host, eventId, 'update:event');

      await updateEvent(key, eventId, { title: 'Edited through the key' }).expect(200);
      expect(await storedTitle(eventId)).toBe('Edited through the key');
    });

    it('refuses a PATCH from a key holding only update:event:cancel, which can still cancel the event', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host);
      const before = await storedTitle(eventId);
      const key = await keyFor(host, eventId, 'update:event:cancel');

      await updateEvent(key, eventId, { title: 'Edited through a cancel key' }).expect(403);
      expect(await storedTitle(eventId)).toBe(before);

      // Control: the key's permission reaches this event, for the columns it is bound to.
      await request(baseUrl).post(`${EVENTS_PATH}/${eventId}/cancel`).set(key.headers).send({}).expect(200);
    });

    it('refuses a PATCH from a key holding only update:event:archive, whose permission still reaches the event', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host);
      const before = await storedTitle(eventId);
      const key = await keyFor(host, eventId, 'update:event:archive');

      await updateEvent(key, eventId, { title: 'Edited through an archive key' }).expect(403);
      expect(await storedTitle(eventId)).toBe(before);

      // Control: the archive route lets the key through to judge the event,
      // which is live and so can't be archived: a 400, not a 403.
      await request(baseUrl).post(`${EVENTS_PATH}/${eventId}/archive`).set(key.headers).expect(400);
    });
  });

  // The direct add places a person without an account, by name, in a role
  // the actor may give out (#539). Every registered user is invited
  // instead and joins by accepting (#742), so delegates and co-hosts are
  // seated that way here.
  describe('adding an attendee (#539)', () => {
    /** A body naming a fresh person without an account, in `role` when given. */
    const byName = (role?: SystemRole) => ({
      guestName: 'Added by name',
      guestEmail: `e2e-attendee-${randomUUID().slice(0, 8)}@example.com`,
      ...(role === undefined ? {} : { role }),
    });

    const { invite } = createEventInviteClient(baseUrl);

    it('lets a host manage the attendees of an event they have just created', async () => {
      // The host's graph is built and cached by the create request itself,
      // before the host row exists. The create has to evict it, or this add
      // is refused until the cache expires.
      const host = await actors.user();
      const eventId = await createdEventId(host);

      const added = attendeeEnvelope(
        await addAttendee(host, eventId, byName()).expect(201),
        'POST /api/events/:eventId/attendees as the new host',
      );
      expect(added.guestName).toBe('Added by name');
    });

    it('refuses the host of one event any add to an event they hold no role on, themselves included', async () => {
      const victim = await actors.user();
      const attacker = await actors.user();
      const targetId = await createdEventId(victim);
      const ownId = await createdEventId(attacker);

      // Control: the attacker holds the attendee grant, on their own event.
      await addAttendee(attacker, ownId, byName()).expect(201);

      // The self-add as co-host is the escalation #539 reported; a registered
      // user now joins only through an invite, so it is asked of
      // the invite route. The by-name adds show the binding refuses every
      // add, not only a managing one.
      const before = await attendeeCount(targetId);
      await invite(attacker, targetId, { userId: attacker.user.id, role: SystemRole.EventCoHost }).expect(403);
      await addAttendee(attacker, targetId, byName()).expect(403);
      await addAttendee(attacker, targetId, byName(SystemRole.EventCoHost)).expect(403);
      expect(await attendeeCount(targetId)).toBe(before);
      expect(await db.client.invite.count({ where: { eventId: targetId } })).toBe(0);
    });

    it.each([SystemRole.EventOrganizer, SystemRole.EventModerator])(
      'refuses an %s adding a co-host, organizer or moderator, and lets the host make the same adds',
      async (delegateRole) => {
        const host = await actors.user();
        const delegate = await actors.user();
        const eventId = await createdEventId(host);
        await inviteAndAccept(baseUrl, host, delegate, eventId, delegateRole);

        // Control: the delegate may add attendees here, in the roles that
        // attend the event rather than run it.
        await addAttendee(delegate, eventId, byName(SystemRole.EventSpectator)).expect(201);

        const before = await attendeeCount(eventId);
        for (const role of MANAGING_ROLES) {
          await addAttendee(delegate, eventId, byName(role)).expect(403);
        }

        expect(await attendeeCount(eventId)).toBe(before);

        for (const role of MANAGING_ROLES) {
          await addAttendee(host, eventId, byName(role)).expect(201);
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
        await inviteAndAccept(baseUrl, host, delegate, eventId, delegateRole);
        await inviteAndAccept(baseUrl, host, coHost, eventId, SystemRole.EventCoHost);
        await inviteAndAccept(baseUrl, host, spectator, eventId, SystemRole.EventSpectator);

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
      const eventId = await createdEventId(host);

      const added = attendeeEnvelope(
        await addAttendee(siteOwner, eventId, byName(SystemRole.EventCoHost)).expect(201),
        "POST /api/events/:eventId/attendees as the site's Owner",
      );
      expect(added.guestName).toBe('Added by name');
    });

    it('refuses a removed co-host on their very next request', async () => {
      // The co-host's own request caches a graph holding the role; the
      // removal has to evict it, or the co-host keeps co-hosting until the
      // cache expires.
      const host = await actors.user();
      const coHost = await actors.user();
      const eventId = await createdEventId(host);
      const { attendeeId: coHostRowId } = await inviteAndAccept(baseUrl, host, coHost, eventId, SystemRole.EventCoHost);

      await addAttendee(coHost, eventId, byName()).expect(201);

      await removeAttendee(host, eventId, coHostRowId).expect(200);

      await addAttendee(coHost, eventId, byName()).expect(403);
    });

    it("lets the household's owner add a co-host to its events without attending, and refuses another household's owner", async () => {
      const owner = await actors.user();
      const member = await actors.user();
      const otherOwner = await actors.user();
      const otherMember = await actors.user();
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
      await addAttendee(otherOwner, otherEventId, byName()).expect(201);
      await addAttendee(otherOwner, eventId, byName()).expect(403);
      expect(await attendeeCount(eventId)).toBe(1);

      const added = attendeeEnvelope(
        await addAttendee(owner, eventId, byName(SystemRole.EventCoHost)).expect(201),
        "POST /api/events/:eventId/attendees as the household's owner",
      );
      expect(added.guestName).toBe('Added by name');
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
      expect(added.suppliedBy.id).toBe(own.suppliedById);
    });
  });

  describe('who adds a game directly (#1215)', () => {
    const lineupCount = (eventId: string) => db.client.eventGame.count({ where: { eventId } });

    // Under either mode the direct add is a host-level write, so a
    // participant's grant must not reach it. The nomination is their way in.
    it.each([GameAdditionMode.HostOnly, GameAdditionMode.Direct])(
      "refuses a participant's direct add under %s, and writes nothing",
      async (gameAdditionMode) => {
        const host = await actors.user();
        const participant = await actors.user();
        const eventId = await createdEventId(host, { policy: { gameAdditionMode } });
        await inviteAndAccept(baseUrl, host, participant, eventId, SystemRole.EventParticipant);
        const own = await arrangeListEntry(db.client, eventId, participant.user.id);
        const hostEntry = await arrangeListEntry(db.client, eventId, host.user.id);

        // Control: the host adds under the same mode, so the refusal is the
        // participant's role and not the mode or the body.
        await directAdd(host, eventId, hostEntry).expect(201);
        const before = await lineupCount(eventId);

        await directAdd(participant, eventId, own).expect(403);
        expect(await lineupCount(eventId)).toBe(before);
      },
    );

    it('lets a co-host add directly under HostOnly', async () => {
      const host = await actors.user();
      const coHost = await actors.user();
      const eventId = await createdEventId(host, { policy: { gameAdditionMode: GameAdditionMode.HostOnly } });
      await inviteAndAccept(baseUrl, host, coHost, eventId, SystemRole.EventCoHost);
      const own = await arrangeListEntry(db.client, eventId, coHost.user.id);

      await directAdd(coHost, eventId, own).expect(201);
      expect(await lineupCount(eventId)).toBe(1);
    });

    it.each([SystemRole.HouseholdOwner, SystemRole.HouseholdAdmin])(
      "lets a household's %s add directly to its event under HostOnly",
      async (householdRole) => {
        const owner = await actors.user();
        const admin = await actors.user();
        const member = await actors.user();
        const plainMember = await actors.user();
        const { household } = await actors.householdWithMembers({
          owner,
          members: [
            { actor: admin, role: SystemRole.HouseholdAdmin },
            { actor: member, role: SystemRole.HouseholdMember },
            { actor: plainMember, role: SystemRole.HouseholdMember },
          ],
        });
        const eventId = await createdEventId(member, {
          householdId: household.id,
          policy: { gameAdditionMode: GameAdditionMode.HostOnly },
        });
        const offered = await arrangeListEntry(db.client, eventId, member.user.id);

        // The add records the attendee who made it, so the household's
        // authority attends as a participant: a role that holds no
        // direct-add grant of its own, as the refusals above show. Only the
        // household grant can make this 201.
        const actor = householdRole === SystemRole.HouseholdOwner ? owner : admin;
        await inviteAndAccept(baseUrl, member, actor, eventId, SystemRole.EventParticipant);

        // Control: a member who is neither the household's owner nor its
        // admin, attending the same way, is refused on the same event, so the
        // 201 below is the household role's.
        await inviteAndAccept(baseUrl, member, plainMember, eventId, SystemRole.EventParticipant);
        await directAdd(plainMember, eventId, offered).expect(403);
        expect(await lineupCount(eventId)).toBe(0);

        await directAdd(actor, eventId, offered).expect(201);
        expect(await lineupCount(eventId)).toBe(1);
      },
    );

    it("still adds a participant's nomination straight to the lineup under Direct", async () => {
      const host = await actors.user();
      const participant = await actors.user();
      const eventId = await createdEventId(host, { policy: { gameAdditionMode: GameAdditionMode.Direct } });
      await inviteAndAccept(baseUrl, host, participant, eventId, SystemRole.EventParticipant);
      const own = await arrangeListEntry(db.client, eventId, participant.user.id);

      const nomination = nominationEnvelope(
        await request(baseUrl)
          .post(`${EVENTS_PATH}/${eventId}/nominations`)
          .set(participant.headers)
          .send({ platformGameId: own.platformGameId, suppliedFromId: own.suppliedById })
          .expect(201),
        'POST /api/events/:eventId/nominations as a participant under Direct',
      );
      expect(nomination.elevatedTo).not.toBeNull();
    });
  });

  describe('removing an occurrence (#558)', () => {
    // These are about who may remove a date, not its status: a Poll event's
    // date is Proposed, which a Fixed event's is not (#677).
    const POLL = { schedulingMode: EventSchedulingMode.Poll };

    it("refuses the host of one event the removal of another event's occurrence, and removes nothing", async () => {
      const host = await actors.user();
      const victim = await actors.user();
      const ownId = await createdEventId(host, POLL);
      const targetId = await createdEventId(victim, POLL);
      const ownOccurrence = await addedOccurrenceId(host, ownId);
      const targetOccurrence = await addedOccurrenceId(victim, targetId);

      await removeOccurrence(host, targetId, targetOccurrence).expect(403);
      expect(await db.client.eventOccurrence.count({ where: { id: targetOccurrence } })).toBe(1);

      // Control: the same host removes their own event's occurrence.
      await removeOccurrence(host, ownId, ownOccurrence).expect(200);
    });

    it.each([SystemRole.HouseholdOwner, SystemRole.HouseholdAdmin])(
      "refuses a %s who doesn't host the household's event the removal of its occurrence, and removes nothing (#168)",
      async (roleName) => {
        // A household's owners and admins edit and cancel its events, and
        // delete an event or its occurrences only as the event's own roles
        // allow. Removing an occurrence they don't host is a request to its
        // host instead (#681).
        const owner = await actors.user();
        const admin = await actors.user();
        const member = await actors.user();
        const { household } = await actors.householdWithMembers({
          owner,
          members: [
            { actor: admin, role: SystemRole.HouseholdAdmin },
            { actor: member, role: SystemRole.HouseholdMember },
          ],
        });
        const actor = roleName === SystemRole.HouseholdOwner ? owner : admin;
        const eventId = await createdEventId(member, { ...POLL, householdId: household.id });
        const occurrenceId = await addedOccurrenceId(member, eventId);

        // Control: the same actor edits the household's event.
        await updateEvent(actor, eventId, { title: 'Edited by the household' }).expect(200);

        await removeOccurrence(actor, eventId, occurrenceId).expect(403);
        expect(await db.client.eventOccurrence.count({ where: { id: occurrenceId } })).toBe(1);

        // Control: the event's host removes it.
        await removeOccurrence(member, eventId, occurrenceId).expect(200);
      },
    );
  });

  describe('deleting an event (#567)', () => {
    // Hosting decides who deletes an event, not authorship: the host deletes
    // it whoever created it, and a creator who no longer hosts it doesn't. A
    // household's owners and admins delete only the household's events they
    // host (#168).
    const deleteEvent = (actor: AuthenticatedActor, eventId: string) =>
      request(baseUrl).delete(`${EVENTS_PATH}/${eventId}`).set(actor.headers);

    const deletedAt = async (eventId: string) =>
      (await db.client.event.findUniqueOrThrow({ where: { id: eventId }, select: { deletedAt: true } })).deletedAt;

    it("lets an event's host delete it, whoever created it", async () => {
      const creator = await actors.user();
      const host = await actors.user();
      const eventId = await createdEventId(creator);
      // A second host, written directly: no route makes one. Arranged before
      // the host's first request, so their graph is built with it.
      await db.client.eventAttendee.create({
        data: {
          event: { connect: { id: eventId } },
          user: { connect: { id: host.user.id } },
          status: EventParticipationStatus.Attending,
          role: { create: { role: { connect: { name: SystemRole.EventHost } } } },
        },
      });

      await deleteEvent(host, eventId).expect(200);

      expect(await deletedAt(eventId)).toBeInstanceOf(Date);
    });

    it('refuses a household owner the deletion of a household event they created but no longer host, and deletes nothing', async () => {
      // The creator hosts the event until a co-host removes them (#547); the
      // removal evicts their cached graph, so the next request is judged
      // without the host role.
      const owner = await actors.user();
      const coHost = await actors.user();
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: coHost, role: SystemRole.HouseholdMember }],
      });
      const eventId = await createdEventId(owner, { householdId: household.id });
      await inviteAndAccept(baseUrl, owner, coHost, eventId, SystemRole.EventCoHost);
      await removeAttendee(coHost, eventId, await attendeeRowId(eventId, owner.user.id)).expect(200);

      // Control: the owner still edits the household's event.
      await updateEvent(owner, eventId, { title: 'Still the household owner' }).expect(200);

      await deleteEvent(owner, eventId).expect(403);
      expect(await deletedAt(eventId)).toBeNull();
    });
  });

  describe("the actor's own attendee row (#458)", () => {
    /**
     * An attendee who attends one event as a spectator, which casts no vote
     * and withdraws no nomination, and another as a participant, which does
     * both. An event role is rendered once per attendance, so the
     * participant's grants are in the attendee's graph beside the
     * spectator's, and each route's type-only check passes on them in either
     * event.
     */
    const arrangeAttendee = async () => {
      const spectatedHost = await actors.user();
      const participatedHost = await actors.user();
      const attendee = await actors.user();
      const spectatedId = await createdEventId(spectatedHost);
      const participatedId = await createdEventId(participatedHost);
      await inviteAndAccept(baseUrl, spectatedHost, attendee, spectatedId, SystemRole.EventSpectator);
      await inviteAndAccept(baseUrl, participatedHost, attendee, participatedId, SystemRole.EventParticipant);

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

    // A spectator answers their own RSVP (#568), on their own row in that
    // event. The grant that lets them is bound to that row, so it reaches no
    // one else's: not the host's in the event they spectate, and not their
    // own in another.
    it("lets a spectator RSVP on their own row, and refuses them anyone else's, leaving it as it was", async () => {
      const { attendee, spectatedHost, spectatedId } = await arrangeAttendee();
      const spectatedRow = await attendeeRowId(spectatedId, attendee.user.id);
      const hostRow = await attendeeRowId(spectatedId, spectatedHost.user.id);
      const hostAnswer = () =>
        db.client.eventAttendee.findUniqueOrThrow({ where: { id: hostRow }, select: { status: true, rsvpDate: true } });
      // The host answered by creating the event, so their row is dated (#1027).
      const before = await hostAnswer();

      await updateStatus(attendee, spectatedId, spectatedRow).expect(200);

      await updateStatus(attendee, spectatedId, hostRow).expect(403);
      // The host's own answer sent again changes nothing, and is still
      // refused: the skip leaves the emit out, never the ceiling (#903).
      await updateStatus(attendee, spectatedId, hostRow, EventParticipationStatus.Attending).expect(403);
      expect(await hostAnswer()).toEqual(before);
      expect(before.status).toBe(EventParticipationStatus.Attending);
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

  describe("a date's status changes (#979)", () => {
    const POLL_WITH_DATE = {
      schedulingMode: EventSchedulingMode.Poll,
      occurrences: [{ startDate: hoursFromNow(24) }],
    };

    const dateOf = async (eventId: string) =>
      db.client.eventOccurrence.findFirstOrThrow({
        where: { eventId },
        select: { id: true, status: true, label: true },
      });

    const datePath = (eventId: string, occurrenceId: string, action = '') =>
      `${EVENTS_PATH}/${eventId}/occurrences/${occurrenceId}${action}`;

    const changeStatus = (
      caller: { headers: Readonly<Record<string, string>> },
      eventId: string,
      occurrenceId: string,
      action: 'confirm' | 'decline' | 'cancel',
    ) =>
      request(baseUrl)
        .post(datePath(eventId, occurrenceId, `/${action}`))
        .set(caller.headers)
        .send({});

    const editLabel = (caller: { headers: Readonly<Record<string, string>> }, eventId: string, occurrenceId: string) =>
      request(baseUrl).patch(datePath(eventId, occurrenceId)).set(caller.headers).send({ label: 'Edited' });

    it.each([
      ['event organizer', SystemRole.EventOrganizer],
      ['event moderator', SystemRole.EventModerator],
    ])('refuses an %s confirming or declining a date, and lets the host', async (_label, delegateRole) => {
      const host = await actors.user();
      const delegate = await actors.user();
      const eventId = await createdEventId(host, POLL_WITH_DATE);
      await inviteAndAccept(baseUrl, host, delegate, eventId, delegateRole);
      const date = await dateOf(eventId);
      expect(date.status).toBe(OccurrenceStatus.Proposed);

      await changeStatus(delegate, eventId, date.id, 'confirm').expect(403);
      await changeStatus(delegate, eventId, date.id, 'decline').expect(403);
      expect((await dateOf(eventId)).status).toBe(OccurrenceStatus.Proposed);

      // Control: the delegate still edits the date, so the refusals above
      // are about the status permissions and not the whole route.
      await editLabel(delegate, eventId, date.id).expect(200);
      expect((await dateOf(eventId)).label).toBe('Edited');

      await changeStatus(host, eventId, date.id, 'confirm').expect(201);
      expect((await dateOf(eventId)).status).toBe(OccurrenceStatus.Confirmed);
    });

    it('refuses an event organizer cancelling a date, and lets an event moderator', async () => {
      const host = await actors.user();
      const eventOrganizer = await actors.user();
      const eventModerator = await actors.user();
      const eventId = await createdEventId(host, {
        schedulingMode: EventSchedulingMode.Fixed,
        occurrences: [{ startDate: hoursFromNow(24) }],
      });
      await inviteAndAccept(baseUrl, host, eventOrganizer, eventId, SystemRole.EventOrganizer);
      await inviteAndAccept(baseUrl, host, eventModerator, eventId, SystemRole.EventModerator);
      const date = await dateOf(eventId);
      expect(date.status).toBe(OccurrenceStatus.Confirmed);

      await changeStatus(eventOrganizer, eventId, date.id, 'cancel').expect(403);
      expect((await dateOf(eventId)).status).toBe(OccurrenceStatus.Confirmed);

      await changeStatus(eventModerator, eventId, date.id, 'cancel').expect(201);
      expect((await dateOf(eventId)).status).toBe(OccurrenceStatus.Cancelled);
    });

    it("lets a household owner confirm and edit a date on the household's event without attending it", async () => {
      const owner = await actors.user();
      const host = await actors.user();
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: host, role: SystemRole.HouseholdMember }],
      });
      const eventId = await createdEventId(host, { ...POLL_WITH_DATE, householdId: household.id });
      const date = await dateOf(eventId);

      await editLabel(owner, eventId, date.id).expect(200);
      expect((await dateOf(eventId)).label).toBe('Edited');

      await changeStatus(owner, eventId, date.id, 'confirm').expect(201);
      expect((await dateOf(eventId)).status).toBe(OccurrenceStatus.Confirmed);
    });

    // The DTO's fields and the edit permission's `fields` are two lists of the
    // same five columns; this ties them, so a field added to one and not the
    // other fails here (#979).
    it('lets the host edit every field a date takes in one patch (#979)', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host, POLL_WITH_DATE);
      const date = await dateOf(eventId);
      const edit = {
        label: 'Every field',
        startDate: hoursFromNow(48),
        endDate: hoursFromNow(50),
        location: 'The game cafe',
        sortOrder: 3,
      };

      await request(baseUrl).patch(datePath(eventId, date.id)).set(host.headers).send(edit).expect(200);

      const row = await db.client.eventOccurrence.findUniqueOrThrow({
        where: { id: date.id },
        select: { label: true, startDate: true, endDate: true, location: true, sortOrder: true },
      });
      expect(row).toEqual({
        label: edit.label,
        startDate: new Date(edit.startDate),
        endDate: new Date(edit.endDate),
        location: edit.location,
        sortOrder: edit.sortOrder,
      });
    });

    it('refuses an API key scoped to only the cancel permission an edit to the date, and one scoped to only the edit permission a confirm', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host, POLL_WITH_DATE);
      const date = await dateOf(eventId);
      const cancelOnly = await mintApiKey(baseUrl, db.client, host, {
        slugs: ['update:event_occurrence:cancel'],
        resourceType: ResourceType.EventOccurrence,
      });
      const editOnly = await mintApiKey(baseUrl, db.client, host, {
        slugs: ['update:event_occurrence'],
        resourceType: ResourceType.EventOccurrence,
      });

      await editLabel(cancelOnly, eventId, date.id).expect(403);
      expect((await dateOf(eventId)).label).toBe(date.label);

      // Control: the edit-only key edits, then is refused the status change.
      await editLabel(editOnly, eventId, date.id).expect(200);
      expect((await dateOf(eventId)).label).toBe('Edited');
      await changeStatus(editOnly, eventId, date.id, 'confirm').expect(403);
      expect((await dateOf(eventId)).status).toBe(OccurrenceStatus.Proposed);
    });
  });
});
