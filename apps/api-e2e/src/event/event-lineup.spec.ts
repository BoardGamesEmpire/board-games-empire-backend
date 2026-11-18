import {
  EventParticipationStatus,
  EventSchedulingMode,
  GameAdditionMode,
  NominationStatus,
  NotificationType,
  ResourceType,
  SystemRole,
} from '@bge/database';
import type { GameRemovedFromEventPayload } from '@bge/notifications-service';
import { LineupRemovalReason } from '@bge/notifications-service';
import type { Actors, AuthenticatedActor } from '@bge/testing-e2e';
import { createActors, pollUntil } from '@bge/testing-e2e';
import request from 'supertest';
import type { Caller } from '../support/api-key';
import { mintApiKey } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { arrangeListEntry } from './event-fixtures';
import { attendeeGamesPath, attendeesPath, createEventClient, EVENTS_PATH } from './event-request';
import type { ListLineupEnvelope } from './event-wire';
import {
  attendeeEnvelope,
  eventGameEnvelope,
  eventReplayEnvelope,
  lineupGameEnvelope,
  listLineupEnvelope,
  listNominationsEnvelope,
  nominationEnvelope,
} from './event-wire';

/**
 * An event's whole lineup in one paged read, over the real routes (#799): the
 * event's own games and the games of each date the actor can read.
 *
 * Every game is put in the lineup through its route; only the supplier's game,
 * and its place on their list for the event, are arranged in the database.
 * Which dates an actor reads is decided by the real CASL extension, in a
 * top-level `where` (#559), so the key that reads no date is proven here, not
 * in the unit specs.
 *
 * A game comes out of the lineup through its route too (#769), and each
 * removal is checked through the read. Whether a lineup has started is a
 * `where` the database applies, so its 409s are proven here, against real
 * dates.
 */
describe('/api/events/:eventId/lineup (#799, #769)', () => {
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

  const lineupPath = (eventId: string) => `${EVENTS_PATH}/${eventId}/lineup`;

  const listLineup = (actor: Caller, eventId: string, query: Record<string, string> = {}) =>
    request(baseUrl).get(lineupPath(eventId)).query(query).set(actor.headers);

  const lineupOf = async (
    actor: Caller,
    eventId: string,
    query: Record<string, string> = {},
  ): Promise<ListLineupEnvelope> =>
    listLineupEnvelope(
      await listLineup(actor, eventId, query).expect(200),
      `GET /api/events/:eventId/lineup ${JSON.stringify(query)}`,
    );

  /** Each row's id and date, the two facts the order and the narrowing turn on. */
  const placesOf = ({ lineup }: ListLineupEnvelope) => lineup.map(({ id, occurrenceId }) => ({ id, occurrenceId }));

  /**
   * The event `host` creates, with one date per label, and the dates' ids.
   * Several dates take MultiDay mode, since a Fixed event holds one. `body`
   * is merged into the create request, such as a `policy`.
   */
  const createdWithDates = async (
    host: AuthenticatedActor,
    labels: readonly string[],
    body: Record<string, unknown> = {},
  ) => {
    const created = eventReplayEnvelope(
      await createEvent(host, {
        ...(labels.length > 1 ? { schedulingMode: EventSchedulingMode.MultiDay } : {}),
        occurrences: labels.map((label) => ({ label })),
        ...body,
      }).expect(201),
      'POST /api/events with dates',
    );

    return { eventId: created.id, dateIds: created.occurrences.map(({ id }) => id) };
  };

  /** Puts a game the host offers in the lineup: the event's own, or the date's when one is named. */
  const directAddedGameId = async (host: AuthenticatedActor, eventId: string, occurrenceId?: string) =>
    eventGameEnvelope(
      await request(baseUrl)
        .post(`${EVENTS_PATH}/${eventId}/nominations/direct-add`)
        .set(host.headers)
        .send({ ...(await arrangeListEntry(db.client, eventId, host.user.id)), occurrenceId })
        .expect(201),
      'POST /api/events/:eventId/nominations/direct-add as the host',
    ).id;

  /**
   * The host's nomination of a game they offer, for the event or the date
   * named, and the entry it comes from. Under Direct mode its game joins the
   * lineup as it is made.
   */
  const nominated = async (host: AuthenticatedActor, eventId: string, occurrenceId?: string) => {
    const entry = await arrangeListEntry(db.client, eventId, host.user.id);
    const nomination = nominationEnvelope(
      await request(baseUrl)
        .post(`${EVENTS_PATH}/${eventId}/nominations`)
        .set(host.headers)
        .send({ platformGameId: entry.platformGameId, suppliedFromId: entry.suppliedById, occurrenceId })
        .expect(201),
      'POST /api/events/:eventId/nominations as the host',
    );

    return { entry, nomination };
  };

  const readNomination = async (actor: Caller, eventId: string, nominationId: string) =>
    nominationEnvelope(
      await request(baseUrl)
        .get(`${EVENTS_PATH}/${eventId}/nominations/${nominationId}`)
        .set(actor.headers)
        .expect(200),
      'GET /api/events/:eventId/nominations/:nominationId',
    );

  const listNominations = async (actor: Caller, eventId: string) =>
    listNominationsEnvelope(
      await request(baseUrl).get(`${EVENTS_PATH}/${eventId}/nominations`).set(actor.headers).expect(200),
      'GET /api/events/:eventId/nominations',
    );

  // An event's own game has no date, and Postgres sorts a null last on an
  // ascending key, so the dates come first.
  it("reads the event's own lineup and each date's, the dates first (#799)", async () => {
    const host = await actors.user();
    const {
      eventId,
      dateIds: [dateId],
    } = await createdWithDates(host, ['Saturday']);
    // Added first, so a read in the order the games were written puts it first.
    const eventsGame = await directAddedGameId(host, eventId);
    const datesGame = await directAddedGameId(host, eventId, dateId);
    const hostAttendee = await db.client.eventAttendee.findUniqueOrThrow({
      where: { eventId_userId: { eventId, userId: host.user.id } },
      select: { id: true },
    });

    const page = await lineupOf(host, eventId);

    expect(placesOf(page)).toEqual([
      { id: datesGame, occurrenceId: dateId },
      { id: eventsGame, occurrenceId: null },
    ]);
    expect(page.total).toBe(2);
    // The host reads their own attendee row, so each game names them as its supplier.
    expect(page.lineup.map(({ suppliedBy }) => suppliedBy.attendee?.id)).toEqual([hostAttendee.id, hostAttendee.id]);
  });

  it("reads a passed nomination's game in the event's own lineup (#799)", async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host, { policy: { gameAdditionMode: GameAdditionMode.Direct } });
    const entry = await arrangeListEntry(db.client, eventId, host.user.id);

    const nomination = nominationEnvelope(
      await request(baseUrl)
        .post(`${EVENTS_PATH}/${eventId}/nominations`)
        .set(host.headers)
        .send({ platformGameId: entry.platformGameId, suppliedFromId: entry.suppliedById })
        .expect(201),
      'POST /api/events/:eventId/nominations under Direct mode',
    );
    // Direct mode passes a nomination as it is made, and puts its game in the lineup.
    expect(nomination.status).toBe(NominationStatus.Passed);

    const { lineup, total } = await lineupOf(host, eventId);

    expect(lineup).toEqual([
      expect.objectContaining({
        nominationId: nomination.id,
        occurrenceId: null,
        platformGameId: entry.platformGameId,
        suppliedBy: expect.objectContaining({ id: entry.suppliedById }),
      }),
    ]);
    expect(total).toBe(1);
  });

  // The write answers the link as the read serves it: the lineup game is read
  // once the nomination's transaction has committed. It names its attendees
  // too, as every read and write answer does (#1213).
  it('links a passed nomination to its lineup game, both ways (#799)', async () => {
    const host = await actors.user();
    const {
      eventId,
      dateIds: [dateId],
    } = await createdWithDates(host, ['Saturday'], { policy: { gameAdditionMode: GameAdditionMode.Direct } });
    const hostAttendee = await db.client.eventAttendee.findUniqueOrThrow({
      where: { eventId_userId: { eventId, userId: host.user.id } },
      select: { id: true },
    });

    const { nomination: written } = await nominated(host, eventId, dateId);
    const {
      lineup: [lineupGame],
      total,
    } = await lineupOf(host, eventId);
    const read = await readNomination(host, eventId, written.id);

    expect(total).toBe(1);
    expect(lineupGame.nominationId).toBe(written.id);
    expect(written.elevatedTo).toEqual({ id: lineupGame.id, occurrenceId: dateId });
    expect(read.elevatedTo).toEqual({ id: lineupGame.id, occurrenceId: dateId });
    expect(written.nominatedBy?.id).toBe(hostAttendee.id);
    expect(written.suppliedFrom.attendee?.id).toBe(hostAttendee.id);
  });

  // The list and the single read serve a nomination through the same reads,
  // so the two agree (#1213). Its game card names the game's subtitle, on the
  // nomination and on the entry that supplies it (#1271).
  it('serves a nomination alike in the list and the single read, its attendees named and its subtitle on both games (#1213, #1271)', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host, { policy: { gameAdditionMode: GameAdditionMode.Direct } });
    const {
      entry,
      nomination: { id: nominationId },
    } = await nominated(host, eventId);
    // The fixture's game has no subtitle; the card must carry one when it has.
    const { gameId } = await db.client.platformGame.findUniqueOrThrow({
      where: { id: entry.platformGameId },
      select: { gameId: true },
    });
    await db.client.game.update({ where: { id: gameId }, data: { subtitle: 'The Card Game' } });
    const hostAttendee = await db.client.eventAttendee.findUniqueOrThrow({
      where: { eventId_userId: { eventId, userId: host.user.id } },
      select: { id: true },
    });

    const listed = await listNominations(host, eventId);
    const read = await readNomination(host, eventId, nominationId);

    expect(listed.total).toBe(1);
    expect(listed.nominations).toEqual([read]);
    expect(read.nominatedBy?.id).toBe(hostAttendee.id);
    expect(read.suppliedFrom.attendee?.id).toBe(hostAttendee.id);
    expect(read.platformGame.game.subtitle).toBe('The Card Game');
    expect(read.suppliedFrom.collection.platformGame.game.subtitle).toBe('The Card Game');
  });

  // The key's owner, the host, reads both attendees and the lineup; the key
  // holds read on nominations alone, so it gets neither, and keeps the ids.
  it('serves both attendees null, ids kept, to an API key that reads nominations but not attendees (#1213)', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host, { policy: { gameAdditionMode: GameAdditionMode.Direct } });
    const {
      entry,
      nomination: { id: nominationId },
    } = await nominated(host, eventId);
    const hostAttendee = await db.client.eventAttendee.findUniqueOrThrow({
      where: { eventId_userId: { eventId, userId: host.user.id } },
      select: { id: true },
    });
    const key = await mintApiKey(baseUrl, db.client, host, {
      slugs: ['read:event_game_nomination'],
      resourceType: ResourceType.EventGameNomination,
    });
    // The control: the host is named twice, and the game is in the lineup.
    const asHost = await readNomination(host, eventId, nominationId);
    expect(asHost.nominatedBy?.id).toBe(hostAttendee.id);
    expect(asHost.suppliedFrom.attendee?.id).toBe(hostAttendee.id);
    expect(asHost.elevatedTo).not.toBeNull();

    const asKey = await readNomination(key, eventId, nominationId);

    expect(asKey.nominatedById).toBe(hostAttendee.id);
    expect(asKey.nominatedBy).toBeNull();
    expect(asKey.suppliedFrom).toEqual(
      expect.objectContaining({ id: entry.suppliedById, attendeeId: hostAttendee.id, attendee: null }),
    );
    // Nor does it read the lineup (#799).
    expect(asKey.elevatedTo).toBeNull();
  });

  it('narrows to one date with occurrenceId (#799)', async () => {
    const host = await actors.user();
    const {
      eventId,
      dateIds: [saturday, sunday],
    } = await createdWithDates(host, ['Saturday', 'Sunday']);
    await directAddedGameId(host, eventId);
    await directAddedGameId(host, eventId, saturday);
    const sundaysGame = await directAddedGameId(host, eventId, sunday);

    // The control: the whole lineup holds all three.
    expect((await lineupOf(host, eventId)).total).toBe(3);

    const narrowed = await lineupOf(host, eventId, { occurrenceId: sunday });

    expect(placesOf(narrowed)).toEqual([{ id: sundaysGame, occurrenceId: sunday }]);
    expect(narrowed.total).toBe(1);
  });

  it('answers 404 for a deleted event (#799)', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);
    await directAddedGameId(host, eventId);

    // The control: the lineup is read before the delete.
    expect((await lineupOf(host, eventId)).total).toBe(1);

    await request(baseUrl).delete(`${EVENTS_PATH}/${eventId}`).set(host.headers).expect(200);

    await listLineup(host, eventId).expect(404);
  });

  // The `User` role holds no read on the lineup; an event's roles grant it.
  it('refuses a user outside the event (#799)', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);
    const outsider = await actors.user();

    // The control: the host reads the same event's lineup.
    await listLineup(host, eventId).expect(200);

    await listLineup(outsider, eventId).expect(403);
  });

  // The lineup's ceiling names a date's games through the date's event, so it
  // would serve this key the date's game: the read of the dates, under their
  // own ceiling, is what keeps it out. The key holds no read on attendees
  // either, so the supplier is not named.
  it("serves the event's own lineup alone to an API key that reads the lineup but no date (#799)", async () => {
    const host = await actors.user();
    const {
      eventId,
      dateIds: [dateId],
    } = await createdWithDates(host, ['Saturday']);
    const eventsGame = await directAddedGameId(host, eventId);
    await directAddedGameId(host, eventId, dateId);
    const key = await mintApiKey(baseUrl, db.client, host, {
      slugs: ['read:event_game'],
      resourceType: ResourceType.EventGame,
    });

    // The control: the key's owner reads both games.
    expect((await lineupOf(host, eventId)).total).toBe(2);

    const page = await lineupOf(key, eventId);

    expect(placesOf(page)).toEqual([{ id: eventsGame, occurrenceId: null }]);
    expect(page.total).toBe(1);
    expect(page.lineup[0].suppliedBy.attendee).toBeNull();
  });

  // The same rule on the nominations' side: a nomination's lineup game is
  // read with its date under the date's own ceiling, so the link serves this
  // key no game the lineup read withholds from it.
  it("serves elevatedTo for the event's own lineup game and null for a date's to an API key that reads nominations and the lineup but no date (#799)", async () => {
    const host = await actors.user();
    const {
      eventId,
      dateIds: [dateId],
    } = await createdWithDates(host, ['Saturday'], { policy: { gameAdditionMode: GameAdditionMode.Direct } });
    const { nomination: ofEvent } = await nominated(host, eventId);
    const { nomination: ofDate } = await nominated(host, eventId, dateId);
    const key = await mintApiKey(baseUrl, db.client, host, [
      { slugs: ['read:event_game'], resourceType: ResourceType.EventGame },
      { slugs: ['read:event_game_nomination'], resourceType: ResourceType.EventGameNomination },
    ]);

    // The control: the key's owner reads both links.
    const eventsLink = (await readNomination(host, eventId, ofEvent.id)).elevatedTo;
    expect(eventsLink).toEqual({ id: expect.any(String), occurrenceId: null });
    expect((await readNomination(host, eventId, ofDate.id)).elevatedTo).toEqual({
      id: expect.any(String),
      occurrenceId: dateId,
    });

    expect((await readNomination(key, eventId, ofEvent.id)).elevatedTo).toEqual(eventsLink);
    expect((await readNomination(key, eventId, ofDate.id)).elevatedTo).toBeNull();
  });

  describe('DELETE /api/events/:eventId/lineup/:lineupGameId (#769)', () => {
    const removeLineupGame = (actor: Caller, eventId: string, lineupGameId: string) =>
      request(baseUrl)
        .delete(`${lineupPath(eventId)}/${lineupGameId}`)
        .set(actor.headers);

    /** The removed game the removal answers, once it answers 200. */
    const removed = async (actor: Caller, eventId: string, lineupGameId: string) =>
      lineupGameEnvelope(
        await removeLineupGame(actor, eventId, lineupGameId).expect(200),
        'DELETE /api/events/:eventId/lineup/:lineupGameId',
      );

    const addAttendee = (host: AuthenticatedActor, eventId: string, attendee: AuthenticatedActor, role: SystemRole) =>
      request(baseUrl)
        .post(attendeesPath(eventId))
        .set(host.headers)
        .send({ userId: attendee.user.id, role })
        .expect(201);

    const DAY = 24 * 60 * 60 * 1000;

    it("a host takes a game out of a date's lineup and out of the event's own (#769)", async () => {
      const host = await actors.user();
      const {
        eventId,
        dateIds: [dateId],
      } = await createdWithDates(host, ['Saturday']);
      const eventsGame = await directAddedGameId(host, eventId);
      const datesGame = await directAddedGameId(host, eventId, dateId);

      // The control: the lineup holds both.
      expect((await lineupOf(host, eventId)).total).toBe(2);

      const fromDate = await removed(host, eventId, datesGame);
      const fromEvent = await removed(host, eventId, eventsGame);

      expect([fromDate, fromEvent].map(({ id, occurrenceId }) => ({ id, occurrenceId }))).toEqual([
        { id: datesGame, occurrenceId: dateId },
        { id: eventsGame, occurrenceId: null },
      ]);
      const after = await lineupOf(host, eventId);
      expect(placesOf(after)).toEqual([]);
      expect(after.total).toBe(0);
    });

    // An event moderator holds the event's own grant. The household's admin
    // attends nothing and holds no event role, so only the household grant
    // reaches it.
    it('an event moderator removes one; a household admin removes one on a household event (#769)', async () => {
      const host = await actors.user();
      const moderator = await actors.user();
      const eventId = await createdEventId(host);
      await addAttendee(host, eventId, moderator, SystemRole.EventModerator);
      const gameId = await directAddedGameId(host, eventId);

      expect((await removed(moderator, eventId, gameId)).id).toBe(gameId);

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
      const householdEventId = await createdEventId(member, { householdId: household.id });
      const householdGameId = await directAddedGameId(member, householdEventId);

      expect((await removed(admin, householdEventId, householdGameId)).id).toBe(householdGameId);

      expect((await lineupOf(host, eventId)).total).toBe(0);
      expect((await lineupOf(member, householdEventId)).total).toBe(0);
    });

    it('refuses a participant, and the lineup is unchanged (#769)', async () => {
      const host = await actors.user();
      const participant = await actors.user();
      const eventId = await createdEventId(host);
      await addAttendee(host, eventId, participant, SystemRole.EventParticipant);
      const gameId = await directAddedGameId(host, eventId);
      const before = placesOf(await lineupOf(host, eventId));

      await removeLineupGame(participant, eventId, gameId).expect(403);

      expect(placesOf(await lineupOf(host, eventId))).toEqual(before);
      // The control: the host removes the same game, so the refusal is the
      // participant's role and not the request.
      await removed(host, eventId, gameId);
    });

    // The route's guard judges the removal by type, and another household's
    // admin holds the household grant, so passes it. The check on the game
    // itself, against the household its event belongs to, refuses them.
    it("refuses another household's admin a game from this household's event, and the lineup is unchanged (#769)", async () => {
      const owner = await actors.user();
      const otherOwner = await actors.user();
      const otherAdmin = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const { household: otherHousehold } = await actors.householdWithMembers({
        owner: otherOwner,
        members: [{ actor: otherAdmin, role: SystemRole.HouseholdAdmin }],
      });
      const eventId = await createdEventId(owner, { householdId: household.id });
      const otherEventId = await createdEventId(otherOwner, { householdId: otherHousehold.id });
      const gameId = await directAddedGameId(owner, eventId);
      const otherGameId = await directAddedGameId(otherOwner, otherEventId);
      const before = placesOf(await lineupOf(owner, eventId));

      // The control: the admin removes a game from their own household's
      // event, so the refusal after it is the household binding's.
      await removed(otherAdmin, otherEventId, otherGameId);

      await removeLineupGame(otherAdmin, eventId, gameId).expect(403);

      expect(placesOf(await lineupOf(owner, eventId))).toEqual(before);
    });

    // A game in a lineup still ahead holds its entry on the supplier's
    // offered games (#551). Once it is out, nothing holds it.
    it('its supplier can take the game off their offered games once it is out (#769)', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host);
      const gameId = await directAddedGameId(host, eventId);
      const {
        lineup: [{ suppliedBy }],
      } = await lineupOf(host, eventId);
      const takeBack = () =>
        request(baseUrl)
          .delete(`${attendeeGamesPath(eventId, suppliedBy.attendeeId)}/${suppliedBy.id}`)
          .set(host.headers);

      await takeBack().expect(409);

      await removed(host, eventId, gameId);

      await takeBack().expect(200);
    });

    /**
     * The game-removed notifications of an event, once `count` of them exist.
     * The listener runs after the response, so the read waits for them; a
     * notification that must NOT exist is checked after one that must.
     */
    const removalNotifications = (eventId: string, count: number) =>
      pollUntil(
        async () => {
          const found = await db.client.notification.findMany({
            where: { type: NotificationType.GameRemovedFromEvent, payload: { path: ['eventId'], equals: eventId } },
            select: { userId: true, payload: true },
          });

          return found.length >= count ? found : undefined;
        },
        { description: `${count} game-removed notifications for event ${eventId}` },
      );

    // The listener's audience and reasons are unit-tested; this proves each
    // route's domain events reach it and the rows land for the right users.
    // The listener reads who is still coming when it runs, so each removal's
    // rows are waited for before the next step changes that.
    it("notifies each removal: a host's, a supplier leaving, a date write (#769)", async () => {
      const host = await actors.user();
      const participant = await actors.user();
      const stayer = await actors.user();
      const {
        eventId,
        dateIds: [, sunday],
      } = await createdWithDates(host, ['Saturday', 'Sunday']);
      const attendingId = async (attendee: AuthenticatedActor) =>
        attendeeEnvelope(
          await request(baseUrl)
            .post(attendeesPath(eventId))
            .set(host.headers)
            .send({ userId: attendee.user.id, status: EventParticipationStatus.Attending })
            .expect(201),
          'POST /api/events/:eventId/attendees as the host',
        ).id;
      const participantId = await attendingId(participant);
      await attendingId(stayer);

      /** A game the participant supplies, in the event's own lineup or the date's named. */
      const participantsGameIn = async (lineup: { eventId: string } | { occurrenceId: string }) => {
        const entry = await arrangeListEntry(db.client, eventId, participant.user.id);
        const { id } = await db.client.eventGame.create({
          data: { ...lineup, platformGameId: entry.platformGameId, suppliedById: entry.suppliedById },
          select: { id: true },
        });

        return id;
      };

      /** The row telling `user` that `lineupGameId` left the lineup, and why. */
      const told = (user: AuthenticatedActor, lineupGameId: string, reason: LineupRemovalReason) => ({
        userId: user.user.id,
        payload: expect.objectContaining({
          eventId,
          lineupGameId,
          reason,
        } satisfies Partial<GameRemovedFromEventPayload>),
      });

      const hostsGame = await directAddedGameId(host, eventId);

      await removed(host, eventId, hostsGame);
      await removalNotifications(eventId, 2);

      // The participant supplies a game for the event and one for Sunday,
      // which has started, and then answers not attending. A started date
      // keeps its lineup, so Sunday's game stays.
      const participantsGame = await participantsGameIn({ eventId });
      const sundaysGame = await participantsGameIn({ occurrenceId: sunday });
      await db.client.eventOccurrence.update({
        where: { id: sunday },
        data: { startDate: new Date(Date.now() - DAY) },
      });

      await request(baseUrl)
        .patch(`${attendeesPath(eventId)}/${participantId}/status`)
        .set(participant.headers)
        .send({ status: EventParticipationStatus.NotAttending })
        .expect(200);
      await removalNotifications(eventId, 4);

      // Moving Sunday's start ahead puts its lineup ahead again, holding a
      // game nobody is bringing, which the date write takes off.
      await request(baseUrl)
        .patch(`${EVENTS_PATH}/${eventId}/occurrences/${sunday}`)
        .set(host.headers)
        .send({ startDate: new Date(Date.now() + DAY).toISOString() })
        .expect(200);

      const all = await removalNotifications(eventId, 5);

      // Nobody is told of their own act, and the participant, out of the
      // event, hears nothing after it.
      expect(all).toHaveLength(5);
      expect(all).toEqual(
        expect.arrayContaining([
          told(participant, hostsGame, LineupRemovalReason.TakenOut),
          told(stayer, hostsGame, LineupRemovalReason.TakenOut),
          told(host, participantsGame, LineupRemovalReason.SupplierLeft),
          told(stayer, participantsGame, LineupRemovalReason.SupplierLeft),
          told(stayer, sundaysGame, LineupRemovalReason.NobodyBringing),
        ]),
      );
    });

    it('the nomination stays Passed, with elevatedTo null (#769)', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host, { policy: { gameAdditionMode: GameAdditionMode.Direct } });
      const { nomination } = await nominated(host, eventId);
      const {
        lineup: [lineupGame],
      } = await lineupOf(host, eventId);
      // The control: Direct mode passed it and put its game in the lineup.
      expect(nomination.status).toBe(NominationStatus.Passed);
      expect(nomination.elevatedTo).toEqual({ id: lineupGame.id, occurrenceId: null });

      await removed(host, eventId, lineupGame.id);

      const read = await readNomination(host, eventId, nomination.id);
      expect(read.status).toBe(NominationStatus.Passed);
      expect(read.elevatedTo).toBeNull();
    });

    // The date's start is arranged in the database: no route moves a date's
    // start into the past.
    it("answers 409 for a started date's game (#769)", async () => {
      const host = await actors.user();
      const {
        eventId,
        dateIds: [dateId],
      } = await createdWithDates(host, ['Saturday']);
      const gameId = await directAddedGameId(host, eventId, dateId);
      await db.client.eventOccurrence.update({
        where: { id: dateId },
        data: { startDate: new Date(Date.now() - DAY) },
      });

      expectErrorEnvelope(await removeLineupGame(host, eventId, gameId), { status: 409, code: 'LINEUP_STARTED' });

      expect(placesOf(await lineupOf(host, eventId))).toEqual([{ id: gameId, occurrenceId: dateId }]);
    });

    // The event's own lineup is ahead while one of its dates is, or while it
    // has none yet.
    it("answers 409 for the event's own game when every date is cancelled, and 200 when the event has no dates (#769)", async () => {
      const host = await actors.user();
      const {
        eventId,
        dateIds: [dateId],
      } = await createdWithDates(host, ['Saturday']);
      const gameId = await directAddedGameId(host, eventId);
      await request(baseUrl)
        .post(`${EVENTS_PATH}/${eventId}/occurrences/${dateId}/cancel`)
        .set(host.headers)
        .expect(201);

      expectErrorEnvelope(await removeLineupGame(host, eventId, gameId), { status: 409, code: 'LINEUP_STARTED' });
      expect(placesOf(await lineupOf(host, eventId))).toEqual([{ id: gameId, occurrenceId: null }]);

      const datelessId = await createdEventId(host);
      const datelessGame = await directAddedGameId(host, datelessId);

      expect((await removed(host, datelessId, datelessGame)).id).toBe(datelessGame);
    });

    // A cancelled event's lineup has started whatever its dates, so one with
    // no dates, whose own lineup would otherwise read as still ahead, keeps
    // its games too, and nobody is told one left.
    it('answers 409 for a game of a cancelled event with no dates (#769)', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host);
      const gameId = await directAddedGameId(host, eventId);
      await request(baseUrl).post(`${EVENTS_PATH}/${eventId}/cancel`).set(host.headers).send({}).expect(200);

      expectErrorEnvelope(await removeLineupGame(host, eventId, gameId), { status: 409, code: 'LINEUP_STARTED' });
      expect(placesOf(await lineupOf(host, eventId))).toEqual([{ id: gameId, occurrenceId: null }]);
    });
  });
});
