import {
  AvailabilityResponse,
  EventParticipationStatus,
  EventSchedulingMode,
  GameAdditionMode,
  NominationStatus,
  OccurrenceStatus,
  Reach,
  VoteType,
} from '@bge/database';
import type { Actors } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { arrangeCollectionEntry } from '../game-collection/game-collection-fixtures';
import { requireBaseUrl } from '../support/e2e-env';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { auditRowsDuring } from './event-audit';
import { arrangeListEntry, hoursFromNow } from './event-fixtures';
import { attendeeGamesPath, attendeesPath, createEventClient, EVENTS_PATH, offerGamesPath } from './event-request';
import { attendeeEnvelope } from './event-wire';

/**
 * Every write beneath an event refuses a deleted event, and one whose
 * household is deleted, with the 404 its read gives, and writes nothing
 * (#1065).
 *
 * Twelve of these routes never checked the event, and eight checked it before
 * the write without a lock; the barrier tests in `event-delete-race.spec.ts`
 * cover the race that left open. Each case arranges an event where the write
 * goes through: the controls send each write to the same arrangement left
 * live, and it answers 2xx. So a write that answers 404 after the delete was
 * refused for the delete and nothing else.
 *
 * Nothing beneath the event changes: each row is read before and after, and
 * compared whole, and the host's audit rows are counted
 * (`auditRowsDuring`).
 */
describe('writes beneath a deleted event (#1065)', () => {
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

  const eventPath = (eventId: string) => `${EVENTS_PATH}/${eventId}`;

  /** A guest attendee's body: a name and an address, both required without an account. */
  const guest = (guestName: string) => ({
    guestName,
    guestEmail: `e2e-guest-${randomUUID().slice(0, 8)}@example.com`,
  });
  const occurrencePath = (eventId: string, occurrenceId: string) => `${eventPath(eventId)}/occurrences/${occurrenceId}`;
  const nominationPath = (eventId: string, nominationId: string) => `${eventPath(eventId)}/nominations/${nominationId}`;

  /** Everything beneath the event, each table in a stable order, to compare whole. */
  const rowsBeneath = async (eventId: string) => {
    const byId = { orderBy: { id: 'asc' } } as const;
    const [event, occurrences, attendees, roles, nominations, votes, availability, offered, lineup] = await Promise.all(
      [
        db.client.event.findUniqueOrThrow({ where: { id: eventId } }),
        db.client.eventOccurrence.findMany({ where: { eventId }, ...byId }),
        db.client.eventAttendee.findMany({ where: { eventId }, ...byId }),
        db.client.eventAttendeeRole.findMany({ where: { eventAttendee: { is: { eventId } } }, ...byId }),
        db.client.eventGameNomination.findMany({ where: { eventId }, ...byId }),
        db.client.eventGameVote.findMany({ where: { nomination: { is: { eventId } } }, ...byId }),
        db.client.eventAvailabilityVote.findMany({ where: { occurrence: { is: { eventId } } }, ...byId }),
        db.client.eventAttendeeGameList.findMany({ where: { attendee: { is: { eventId } } }, ...byId }),
        db.client.eventGame.findMany({
          where: { OR: [{ eventId }, { occurrence: { is: { eventId } } }] },
          ...byId,
        }),
      ],
    );

    return { event, occurrences, attendees, roles, nominations, votes, availability, offered, lineup };
  };

  type Delete = 'the event' | 'its household';

  /**
   * An event the host attends, in a household the host owns alone when
   * `inHousehold`, where every write below would go through:
   *
   * - a Proposed and a Confirmed date;
   * - a guest attendee;
   * - an Open and an AwaitingApproval nomination by the host;
   * - games the host offers, one each for a nomination, a direct add and a
   *   take-back, and a collection entry not yet offered.
   *
   * It takes several dates, so adding one is open, and the policy adds games
   * directly, so both a nomination and a direct add are open. The nominations
   * are written as rows in the states the settles need.
   */
  const arrange = async (deleted: Delete) => {
    const host = await actors.user();
    const householdId =
      deleted === 'its household'
        ? (await actors.householdWithMembers({ owner: host, members: [] })).household.id
        : undefined;
    const eventId = await createdEventId(host, {
      householdId,
      schedulingMode: EventSchedulingMode.MultiDay,
      policy: { gameAdditionMode: GameAdditionMode.Direct },
    });
    const hostAttendee = await db.client.eventAttendee.findFirstOrThrow({
      where: { eventId, userId: host.user.id },
      select: { id: true },
    });
    const guestAttendeeId = attendeeEnvelope(
      await request(baseUrl).post(attendeesPath(eventId)).set(host.headers).send(guest('Sam')).expect(201),
      'POST /api/events/:eventId/attendees as the host',
    ).id;

    const [proposed, confirmed] = await Promise.all(
      [OccurrenceStatus.Proposed, OccurrenceStatus.Confirmed].map((status) =>
        db.client.eventOccurrence.create({ data: { eventId, status }, select: { id: true } }),
      ),
    );

    const nominated = async (status: NominationStatus) => {
      const entry = await arrangeListEntry(db.client, eventId, host.user.id);

      return (
        await db.client.eventGameNomination.create({
          data: {
            eventId,
            platformGameId: entry.platformGameId,
            suppliedFromId: entry.suppliedById,
            nominatedById: hostAttendee.id,
            status,
          },
          select: { id: true },
        })
      ).id;
    };

    return {
      host,
      eventId,
      householdId,
      hostAttendeeId: hostAttendee.id,
      guestAttendeeId,
      proposedId: proposed.id,
      confirmedId: confirmed.id,
      openNominationId: await nominated(NominationStatus.Open),
      awaitingNominationId: await nominated(NominationStatus.AwaitingApproval),
      toNominate: await arrangeListEntry(db.client, eventId, host.user.id),
      toDirectAdd: await arrangeListEntry(db.client, eventId, host.user.id),
      toTakeBack: await arrangeListEntry(db.client, eventId, host.user.id),
      toOffer: await arrangeCollectionEntry(db.client, host.user.id, Reach.Private),
    };
  };

  type Arranged = Awaited<ReturnType<typeof arrange>>;

  const deleteIt = async (deleted: Delete, { host, eventId, householdId }: Arranged) => {
    if (deleted === 'the event') {
      await request(baseUrl).delete(eventPath(eventId)).set(host.headers).expect(200);

      return;
    }

    await request(baseUrl).delete(`/api/households/${householdId}`).set(host.headers).expect(200);
  };

  /** Each write beneath the event, as the host sends it. */
  const writes: { route: string; send: (arranged: Arranged) => request.Test }[] = [
    // Dates.
    {
      route: 'POST /occurrences (add a date)',
      send: ({ host, eventId }) =>
        request(baseUrl)
          .post(`${eventPath(eventId)}/occurrences`)
          .set(host.headers)
          .send({ startDate: hoursFromNow(48) }),
    },
    {
      route: 'PATCH /occurrences/:id (edit a date)',
      send: ({ host, eventId, proposedId }) =>
        request(baseUrl).patch(occurrencePath(eventId, proposedId)).set(host.headers).send({ label: 'Too late' }),
    },
    {
      route: 'DELETE /occurrences/:id (remove a date)',
      send: ({ host, eventId, proposedId }) =>
        request(baseUrl).delete(occurrencePath(eventId, proposedId)).set(host.headers),
    },
    {
      route: 'POST /occurrences/:id/confirm',
      send: ({ host, eventId, proposedId }) =>
        request(baseUrl)
          .post(`${occurrencePath(eventId, proposedId)}/confirm`)
          .set(host.headers),
    },
    {
      route: 'POST /occurrences/:id/decline',
      send: ({ host, eventId, proposedId }) =>
        request(baseUrl)
          .post(`${occurrencePath(eventId, proposedId)}/decline`)
          .set(host.headers),
    },
    {
      route: 'POST /occurrences/:id/cancel',
      send: ({ host, eventId, confirmedId }) =>
        request(baseUrl)
          .post(`${occurrencePath(eventId, confirmedId)}/cancel`)
          .set(host.headers)
          .send({}),
    },
    {
      route: 'POST /occurrences/:id/availability',
      send: ({ host, eventId, proposedId }) =>
        request(baseUrl)
          .post(`${occurrencePath(eventId, proposedId)}/availability`)
          .set(host.headers)
          .send({ response: AvailabilityResponse.Available }),
    },
    // Nominations.
    {
      route: 'POST /nominations (nominate)',
      send: ({ host, eventId, toNominate }) =>
        request(baseUrl)
          .post(`${eventPath(eventId)}/nominations`)
          .set(host.headers)
          .send({ platformGameId: toNominate.platformGameId, suppliedFromId: toNominate.suppliedById }),
    },
    {
      route: 'POST /nominations/direct-add',
      send: ({ host, eventId, toDirectAdd }) =>
        request(baseUrl)
          .post(`${eventPath(eventId)}/nominations/direct-add`)
          .set(host.headers)
          .send(toDirectAdd),
    },
    {
      route: 'PATCH /nominations/:id/withdraw',
      send: ({ host, eventId, openNominationId }) =>
        request(baseUrl)
          .patch(`${nominationPath(eventId, openNominationId)}/withdraw`)
          .set(host.headers),
    },
    {
      route: 'POST /nominations/:id/votes',
      send: ({ host, eventId, openNominationId }) =>
        request(baseUrl)
          .post(`${nominationPath(eventId, openNominationId)}/votes`)
          .set(host.headers)
          .send({ voteType: VoteType.For }),
    },
    {
      route: 'POST /nominations/:id/resolve',
      send: ({ host, eventId, openNominationId }) =>
        request(baseUrl)
          .post(`${nominationPath(eventId, openNominationId)}/resolve`)
          .set(host.headers),
    },
    {
      route: 'POST /nominations/:id/approve',
      send: ({ host, eventId, awaitingNominationId }) =>
        request(baseUrl)
          .post(`${nominationPath(eventId, awaitingNominationId)}/approve`)
          .set(host.headers),
    },
    {
      route: 'POST /nominations/:id/reject',
      send: ({ host, eventId, awaitingNominationId }) =>
        request(baseUrl)
          .post(`${nominationPath(eventId, awaitingNominationId)}/reject`)
          .set(host.headers),
    },
    // Attendees.
    {
      route: 'POST /attendees (add an attendee)',
      send: ({ host, eventId }) =>
        request(baseUrl).post(attendeesPath(eventId)).set(host.headers).send(guest('Too late')),
    },
    {
      route: 'DELETE /attendees/:id (remove an attendee)',
      send: ({ host, eventId, guestAttendeeId }) =>
        request(baseUrl)
          .delete(`${attendeesPath(eventId)}/${guestAttendeeId}`)
          .set(host.headers),
    },
    {
      route: 'PATCH /attendees/:id/status (RSVP)',
      send: ({ host, eventId, hostAttendeeId }) =>
        request(baseUrl)
          .patch(`${attendeesPath(eventId)}/${hostAttendeeId}/status`)
          .set(host.headers)
          .send({ status: EventParticipationStatus.NotAttending }),
    },
    {
      route: 'POST /attendees/:id/games (offer a game)',
      send: ({ host, eventId, hostAttendeeId, toOffer }) =>
        request(baseUrl)
          .post(attendeeGamesPath(eventId, hostAttendeeId))
          .set(host.headers)
          .send({ collectionId: toOffer }),
    },
    {
      route: 'POST /attendees/:id/games/batch (offer several games)',
      send: ({ host, eventId, hostAttendeeId, toOffer }) =>
        request(baseUrl)
          .post(offerGamesPath(eventId, hostAttendeeId))
          .set(host.headers)
          .send({ items: [{ collectionId: toOffer }] }),
    },
    {
      route: 'DELETE /attendees/:id/games/:gameListId (take a game back)',
      send: ({ host, eventId, hostAttendeeId, toTakeBack }) =>
        request(baseUrl)
          .delete(`${attendeeGamesPath(eventId, hostAttendeeId)}/${toTakeBack.suppliedById}`)
          .set(host.headers),
    },
  ];

  const cases = (['the event', 'its household'] as const).flatMap((deleted) =>
    writes.map((write) => ({ ...write, deleted })),
  );

  // The control for each case below: the same arrangement, left live, takes
  // the write.
  it.each(cases)('$route goes through while $deleted is live (control)', async ({ deleted, send }) => {
    const arranged = await arrange(deleted);

    const response = await send(arranged);

    expect([200, 201]).toContain(response.status);
  });

  it.each(cases)('$route answers 404 after deleting $deleted, and writes nothing', async ({ deleted, send }) => {
    const arranged = await arrange(deleted);
    await deleteIt(deleted, arranged);
    const before = await rowsBeneath(arranged.eventId);

    const { auditRows } = await auditRowsDuring(baseUrl, db.client, arranged.host, () => send(arranged).expect(404));

    expect(await rowsBeneath(arranged.eventId)).toEqual(before);
    expect(auditRows).toBe(0);
  });
});
