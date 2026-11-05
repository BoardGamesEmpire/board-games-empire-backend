import {
  AvailabilityResponse,
  EventParticipationStatus,
  GameAdditionMode,
  NominationStatus,
  OccurrenceStatus,
  SystemRole,
  VoteThresholdType,
  VoteType,
} from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { arrangeListEntry } from './event-fixtures';
import { createEventClient, EVENTS_PATH } from './event-request';
import {
  attendeeEnvelope,
  availabilitySummaryEnvelope,
  nominationEnvelope,
  occurrenceEnvelope,
  resolutionEnvelope,
  type NominationWire,
} from './event-wire';

/**
 * Who counts as a voter, and what a resolve stores, over the real routes.
 *
 * - An attendee counts as a voter only when their event role holds the vote
 *   and they have an account someone can cast it as (#759). A vote cast
 *   under a role that has since lost the vote is kept, shown, and not
 *   counted.
 * - Everyone reading the votes sees the same marks: whether a voter's role
 *   holds the vote is read for the count, whatever the reader may read of
 *   roles.
 */
describe('vote eligibility', () => {
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

  const addAttendee = (actor: AuthenticatedActor, eventId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(`${EVENTS_PATH}/${eventId}/attendees`).set(actor.headers).send(body);

  /** The attendee id of a user `host` adds to the event, attending, with the role given. */
  const addedAttending = async (
    host: AuthenticatedActor,
    eventId: string,
    actor: AuthenticatedActor,
    role: SystemRole = SystemRole.EventParticipant,
  ) =>
    attendeeEnvelope(
      await addAttendee(host, eventId, {
        userId: actor.user.id,
        role,
        status: EventParticipationStatus.Attending,
      }).expect(201),
      'POST /api/events/:eventId/attendees as the host',
    ).id;

  const removeAttendee = (actor: AuthenticatedActor, eventId: string, attendeeId: string) =>
    request(baseUrl).delete(`${EVENTS_PATH}/${eventId}/attendees/${attendeeId}`).set(actor.headers);

  /** The id of the host's nomination of a game they offer. */
  const nominatedByHost = async (host: AuthenticatedActor, eventId: string) => {
    const entry = await arrangeListEntry(db.client, eventId, host.user.id);

    return nominationEnvelope(
      await request(baseUrl)
        .post(`${EVENTS_PATH}/${eventId}/nominations`)
        .set(host.headers)
        .send({ platformGameId: entry.platformGameId, suppliedFromId: entry.suppliedById })
        .expect(201),
      'POST /api/events/:eventId/nominations',
    ).id;
  };

  const castVote = (actor: AuthenticatedActor, eventId: string, nominationId: string, voteType: VoteType) =>
    request(baseUrl)
      .post(`${EVENTS_PATH}/${eventId}/nominations/${nominationId}/votes`)
      .set(actor.headers)
      .send({ voteType })
      .expect(201);

  const readNomination = async (actor: AuthenticatedActor, eventId: string, nominationId: string) =>
    nominationEnvelope(
      await request(baseUrl)
        .get(`${EVENTS_PATH}/${eventId}/nominations/${nominationId}`)
        .set(actor.headers)
        .expect(200),
      'GET /api/events/:eventId/nominations/:nominationId',
    );

  const resolve = (actor: AuthenticatedActor, eventId: string, nominationId: string) =>
    request(baseUrl).post(`${EVENTS_PATH}/${eventId}/nominations/${nominationId}/resolve`).set(actor.headers);

  const resolved = async (actor: AuthenticatedActor, eventId: string, nominationId: string) =>
    resolutionEnvelope(
      await resolve(actor, eventId, nominationId).expect(201),
      'POST /api/events/:eventId/nominations/:nominationId/resolve',
    );

  /** The host's own attendee row, which creating the event wrote. */
  const hostAttendeeId = async (host: AuthenticatedActor, eventId: string) =>
    (
      await db.client.eventAttendee.findFirstOrThrow({
        where: { eventId, userId: host.user.id },
        select: { id: true },
      })
    ).id;

  const voteOf = (nomination: NominationWire, attendeeId: string) =>
    nomination.votes.find((vote) => vote.attendeeId === attendeeId);

  const answerAvailable = (actor: AuthenticatedActor, eventId: string, occurrenceId: string) =>
    request(baseUrl)
      .post(`${EVENTS_PATH}/${eventId}/occurrences/${occurrenceId}/availability`)
      .set(actor.headers)
      .send({ response: AvailabilityResponse.Available })
      .expect(201);

  const readSummary = async (actor: AuthenticatedActor, eventId: string) =>
    availabilitySummaryEnvelope(
      await request(baseUrl)
        .get(`${EVENTS_PATH}/${eventId}/occurrences/summary/availability`)
        .set(actor.headers)
        .expect(200),
      'GET /api/events/:eventId/occurrences/summary/availability',
    );

  describe('on a nomination', () => {
    it('passes a Unanimous nomination with a spectator and an attendee without an account attending: neither can vote, so neither counts', async () => {
      const [host, participant, spectator] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      const eventId = await createdEventId(host, {
        policy: { gameAdditionMode: GameAdditionMode.RequiresVote, voteThresholdType: VoteThresholdType.Unanimous },
      });
      await addedAttending(host, eventId, participant);
      await addedAttending(host, eventId, spectator, SystemRole.EventSpectator);
      await addAttendee(host, eventId, {
        guestName: 'Pat',
        guestEmail: 'pat@example.test',
        status: EventParticipationStatus.Attending,
      }).expect(201);

      const nominationId = await nominatedByHost(host, eventId);
      await castVote(host, eventId, nominationId, VoteType.For);
      await castVote(participant, eventId, nominationId, VoteType.For);

      const { resolution } = await resolved(host, eventId, nominationId);

      expect(resolution.status).toBe(NominationStatus.Passed);
      expect(resolution.eligibleVoterCount).toBe(2);
    });

    it("doesn't count the vote of a participant removed and added back as a spectator, and shows it as not counting", async () => {
      const [host, participant] = await Promise.all([actors.user(), actors.user()]);
      const eventId = await createdEventId(host, { policy: { gameAdditionMode: GameAdditionMode.RequiresVote } });
      const participantId = await addedAttending(host, eventId, participant);

      const nominationId = await nominatedByHost(host, eventId);
      await castVote(host, eventId, nominationId, VoteType.For);
      await castVote(participant, eventId, nominationId, VoteType.Against);

      await removeAttendee(host, eventId, participantId).expect(200);
      // The same row comes back, under the role it is added back with (#551).
      expect(await addedAttending(host, eventId, participant, SystemRole.EventSpectator)).toBe(participantId);

      const read = await readNomination(participant, eventId, nominationId);
      expect(voteOf(read, participantId)).toMatchObject({ voteType: VoteType.Against, eligible: false });
      expect(voteOf(read, await hostAttendeeId(host, eventId))).toMatchObject({
        voteType: VoteType.For,
        eligible: true,
      });

      const { resolution } = await resolved(host, eventId, nominationId);

      // Counted as cast, the spectator's Against would have tied it, and failed it.
      expect(resolution.status).toBe(NominationStatus.Passed);
      expect(resolution.tally.totalVotes).toBe(1);
    });

    it("a participant reading the nomination sees the host's vote and their own counted", async () => {
      const [host, participant] = await Promise.all([actors.user(), actors.user()]);
      const eventId = await createdEventId(host, { policy: { gameAdditionMode: GameAdditionMode.RequiresVote } });
      const participantId = await addedAttending(host, eventId, participant);

      const nominationId = await nominatedByHost(host, eventId);
      await castVote(host, eventId, nominationId, VoteType.For);
      await castVote(participant, eventId, nominationId, VoteType.Against);

      const read = await readNomination(participant, eventId, nominationId);

      expect(voteOf(read, await hostAttendeeId(host, eventId))?.eligible).toBe(true);
      expect(voteOf(read, participantId)?.eligible).toBe(true);
    });
  });

  describe('on a date', () => {
    it("counts no spectator among the availability poll's eligible voters, read by a participant", async () => {
      const [host, participant, spectator] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      const eventId = await createdEventId(host);
      await addedAttending(host, eventId, participant);
      const spectatorId = await addedAttending(host, eventId, spectator, SystemRole.EventSpectator);
      const { id: occurrenceId } = await db.client.eventOccurrence.create({
        data: { eventId, status: OccurrenceStatus.Proposed },
        select: { id: true },
      });

      await answerAvailable(host, eventId, occurrenceId);
      await answerAvailable(participant, eventId, occurrenceId);
      // A spectator can't answer through the route, but a vote cast under an
      // earlier role looks the same, and the count must leave it out.
      await db.client.eventAvailabilityVote.create({
        data: { occurrenceId, attendeeId: spectatorId, response: AvailabilityResponse.Available },
      });

      const summary = await readSummary(participant, eventId);
      const date = summary.occurrences.find((entry) => entry.occurrenceId === occurrenceId);

      expect(summary.eligibleVoters).toBe(2);
      expect(date).toMatchObject({ available: 2, totalVotes: 2, pendingVotes: 0, participationRate: 1 });
      expect(date?.voters.find((voter) => voter.attendeeId === spectatorId)?.eligible).toBe(false);

      // The date's own route marks the vote as the summary does.
      const occurrence = occurrenceEnvelope(
        await request(baseUrl)
          .get(`${EVENTS_PATH}/${eventId}/occurrences/${occurrenceId}`)
          .set(participant.headers)
          .expect(200),
        'GET /api/events/:eventId/occurrences/:occurrenceId',
      );
      expect(occurrence.availabilityVotes.find((vote) => vote.attendeeId === spectatorId)?.eligible).toBe(false);
      expect(occurrence.availabilityVotes.filter((vote) => vote.eligible)).toHaveLength(2);
    });
  });
});
