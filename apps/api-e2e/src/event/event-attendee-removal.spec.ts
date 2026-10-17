import {
  AvailabilityResponse,
  EventParticipationStatus,
  EventSchedulingMode,
  GameAdditionMode,
  NominationStatus,
  OccurrenceStatus,
  VoteType,
} from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { expectBackendsQueuedBehind, expectLockWaiter, withBarrier, type Barrier } from '../support/lock-barrier';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { arrangeListEntry } from './event-fixtures';
import { createEventClient, EVENTS_PATH } from './event-request';
import {
  attendeeEnvelope,
  availabilitySummaryEnvelope,
  eventGameEnvelope,
  nominationEnvelope,
  occurrenceEnvelope,
  resolutionEnvelope,
  type NominationWire,
} from './event-wire';

/**
 * Leaving an event, over the real routes (#551).
 *
 * Removing an attendee who had taken part answered 500: five keys into the
 * attendee row refused the delete. The row is now kept and marked removed,
 * and whoever is out of the event, removed by a host or not attending, is
 * out the same way:
 *
 * - their votes stay, and stop counting until they are back;
 * - the nominations they made of someone else's game stay open, naming them;
 * - the nominations of a game they offered pause, and reopen when they are
 *   back;
 * - the games they supply leave the lineup of every date still ahead, and
 *   stay off it;
 * - removed by a host, they lose their role, and every grant with it.
 *
 * Each test below arranges the same event: a host, a leaver and a stayer,
 * the leaver having nominated, voted and offered games.
 */
describe('leaving an event', () => {
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

  const removeAttendee = (actor: AuthenticatedActor, eventId: string, attendeeId: string) =>
    request(baseUrl).delete(`${EVENTS_PATH}/${eventId}/attendees/${attendeeId}`).set(actor.headers);

  const rsvp = (actor: AuthenticatedActor, eventId: string, attendeeId: string, status: EventParticipationStatus) =>
    request(baseUrl)
      .patch(`${EVENTS_PATH}/${eventId}/attendees/${attendeeId}/status`)
      .set(actor.headers)
      .send({ status });

  /** A nomination of the game on a list entry, which `arrangeListEntry` shapes for a direct add. */
  const nominate = (
    actor: AuthenticatedActor,
    eventId: string,
    entry: { platformGameId: string; suppliedById: string },
  ) =>
    request(baseUrl)
      .post(`${EVENTS_PATH}/${eventId}/nominations`)
      .set(actor.headers)
      .send({ platformGameId: entry.platformGameId, suppliedFromId: entry.suppliedById });

  const castVote = (actor: AuthenticatedActor, eventId: string, nominationId: string, voteType: VoteType) =>
    request(baseUrl)
      .post(`${EVENTS_PATH}/${eventId}/nominations/${nominationId}/votes`)
      .set(actor.headers)
      .send({ voteType });

  const readNomination = async (actor: AuthenticatedActor, eventId: string, nominationId: string) =>
    nominationEnvelope(
      await request(baseUrl)
        .get(`${EVENTS_PATH}/${eventId}/nominations/${nominationId}`)
        .set(actor.headers)
        .expect(200),
      'GET /api/events/:eventId/nominations/:nominationId',
    );

  const listGames = (actor: AuthenticatedActor, eventId: string, attendeeId: string) =>
    request(baseUrl).get(`${EVENTS_PATH}/${eventId}/attendees/${attendeeId}/games`).set(actor.headers);

  const removeGame = (actor: AuthenticatedActor, eventId: string, attendeeId: string, gameListId: string) =>
    request(baseUrl).delete(`${EVENTS_PATH}/${eventId}/attendees/${attendeeId}/games/${gameListId}`).set(actor.headers);

  /** The availability summary's entry for one date, as the host reads it. */
  const summaryOf = async (actor: AuthenticatedActor, eventId: string, occurrenceId: string) =>
    availabilitySummaryEnvelope(
      await request(baseUrl)
        .get(`${EVENTS_PATH}/${eventId}/occurrences/summary/availability`)
        .set(actor.headers)
        .expect(200),
      'GET /api/events/:eventId/occurrences/summary/availability',
    ).occurrences.find((entry) => entry.occurrenceId === occurrenceId);

  const voteOf = (nomination: NominationWire, attendeeId: string) =>
    nomination.votes.find((vote) => vote.attendeeId === attendeeId);

  const scheduledGameExists = async (id: string) => (await db.client.eventGame.count({ where: { id } })) === 1;

  const DAY = 24 * 60 * 60 * 1000;

  /** A confirmed date of the event, starting at `startDate`. */
  const confirmedDate = async (eventId: string, startDate: Date) =>
    (
      await db.client.eventOccurrence.create({
        data: { eventId, status: OccurrenceStatus.Confirmed, startDate },
        select: { id: true },
      })
    ).id;

  /** A game from `supplier`'s offered games, in the lineup of the date, and the entry it comes from. */
  const inLineupOf = async (eventId: string, occurrenceId: string, supplier: AuthenticatedActor) => {
    const entry = await arrangeListEntry(db.client, eventId, supplier.user.id);
    const { id } = await db.client.eventGame.create({
      data: { occurrenceId, platformGameId: entry.platformGameId, suppliedById: entry.suppliedById },
      select: { id: true },
    });

    return { id, entryId: entry.suppliedById };
  };

  /**
   * An event that votes on its games, with a host, a leaver and a stayer,
   * all attending:
   *
   * - `ofOthersGame`: the leaver's nomination of the host's game, which the leaver voted for;
   * - `ofLeaversGame`: the host's nomination of a game the leaver offered, which the stayer voted for;
   * - `scheduledGameId`: a game in the lineup the leaver supplies;
   * - `dateVoteId`: the leaver's availability on a proposed date.
   */
  const arrangeEvent = async () => {
    const host = await actors.user();
    const leaver = await actors.user();
    const stayer = await actors.user();
    const eventId = await createdEventId(host, { policy: { gameAdditionMode: GameAdditionMode.RequiresVote } });

    const addAttending = async (actor: AuthenticatedActor) =>
      attendeeEnvelope(
        await addAttendee(host, eventId, { userId: actor.user.id, status: EventParticipationStatus.Attending }).expect(
          201,
        ),
        'POST /api/events/:eventId/attendees as the host',
      ).id;

    const leaverId = await addAttending(leaver);
    const stayerId = await addAttending(stayer);

    const nominated = async (actor: AuthenticatedActor, ownerId: string) =>
      nominationEnvelope(
        await nominate(actor, eventId, await arrangeListEntry(db.client, eventId, ownerId)).expect(201),
        'POST /api/events/:eventId/nominations',
      );

    const ofOthersGame = await nominated(leaver, host.user.id);
    const ofLeaversGame = await nominated(host, leaver.user.id);
    await castVote(leaver, eventId, ofOthersGame.id, VoteType.For).expect(201);
    await castVote(stayer, eventId, ofLeaversGame.id, VoteType.For).expect(201);

    // The lineup's direct add is closed while the event votes on its games,
    // so the scheduled game is arranged as the host's earlier add.
    const lineupEntry = await arrangeListEntry(db.client, eventId, leaver.user.id);
    const { id: scheduledGameId } = await db.client.eventGame.create({
      data: { eventId, platformGameId: lineupEntry.platformGameId, suppliedById: lineupEntry.suppliedById },
      select: { id: true },
    });

    const { id: occurrenceId } = await db.client.eventOccurrence.create({
      data: { eventId, status: OccurrenceStatus.Proposed },
      select: { id: true },
    });
    await request(baseUrl)
      .post(`${EVENTS_PATH}/${eventId}/occurrences/${occurrenceId}/availability`)
      .set(leaver.headers)
      .send({ response: AvailabilityResponse.Available })
      .expect(201);
    const { id: dateVoteId } = await db.client.eventAvailabilityVote.findUniqueOrThrow({
      where: { occurrenceId_attendeeId: { occurrenceId, attendeeId: leaverId } },
      select: { id: true },
    });

    return {
      host,
      leaver,
      stayer,
      eventId,
      leaverId,
      stayerId,
      ofOthersGame,
      ofLeaversGame,
      scheduledGameId,
      occurrenceId,
      dateVoteId,
    };
  };

  describe('removed by a host', () => {
    it('removes an attendee who nominated, voted and supplied games, where it answered 500', async () => {
      const { host, eventId, leaverId } = await arrangeEvent();

      await removeAttendee(host, eventId, leaverId).expect(200);

      const row = await db.client.eventAttendee.findUniqueOrThrow({
        where: { id: leaverId },
        select: { removedAt: true, role: true },
      });
      expect(row.removedAt).toBeInstanceOf(Date);
      expect(row.role).toBeNull();
    });

    it('keeps their votes, on games and dates, and stops counting them', async () => {
      const { host, eventId, leaverId, ofOthersGame, occurrenceId, dateVoteId } = await arrangeEvent();
      expect(voteOf(await readNomination(host, eventId, ofOthersGame.id), leaverId)?.eligible).toBe(true);
      expect((await summaryOf(host, eventId, occurrenceId))?.available).toBe(1);

      await removeAttendee(host, eventId, leaverId).expect(200);

      expect(voteOf(await readNomination(host, eventId, ofOthersGame.id), leaverId)).toMatchObject({
        voteType: VoteType.For,
        eligible: false,
      });
      expect(await db.client.eventAvailabilityVote.count({ where: { id: dateVoteId } })).toBe(1);
      expect((await summaryOf(host, eventId, occurrenceId))?.available).toBe(0);
    });

    it("keeps their nominations of someone else's game open, naming them", async () => {
      const { host, eventId, leaverId, ofOthersGame } = await arrangeEvent();

      await removeAttendee(host, eventId, leaverId).expect(200);

      const nomination = await readNomination(host, eventId, ofOthersGame.id);
      expect(nomination.status).toBe(NominationStatus.Open);
      expect(nomination.nominatedBy.id).toBe(leaverId);
    });

    it('pauses the nominations of a game they offered, keeping the votes on them', async () => {
      const { host, eventId, leaverId, stayerId, ofLeaversGame } = await arrangeEvent();

      await removeAttendee(host, eventId, leaverId).expect(200);

      const nomination = await readNomination(host, eventId, ofLeaversGame.id);
      expect(nomination.status).toBe(NominationStatus.Paused);
      expect(nomination.pausedFrom).toBe(NominationStatus.Open);
      expect(voteOf(nomination, stayerId)).toMatchObject({ voteType: VoteType.For, eligible: true });

      // A paused nomination cannot be resolved.
      await request(baseUrl)
        .post(`${EVENTS_PATH}/${eventId}/nominations/${ofLeaversGame.id}/resolve`)
        .set(host.headers)
        .expect(400);
    });

    it('takes the games they supply off the lineup', async () => {
      const { host, eventId, leaverId, scheduledGameId } = await arrangeEvent();

      await removeAttendee(host, eventId, leaverId).expect(200);

      expect(await scheduledGameExists(scheduledGameId)).toBe(false);
    });

    it('takes every grant on the event, and their place in its lists, from their very next request', async () => {
      const { host, leaver, eventId, leaverId, ofOthersGame } = await arrangeEvent();

      await removeAttendee(host, eventId, leaverId).expect(200);

      await castVote(leaver, eventId, ofOthersGame.id, VoteType.Against).expect(403);
      await request(baseUrl).get(`${EVENTS_PATH}/${eventId}`).set(leaver.headers).expect(404);

      const listed = await request(baseUrl).get(`${EVENTS_PATH}/${eventId}/attendees`).set(host.headers).expect(200);
      expect((listed.body.attendees as { id: string }[]).map(({ id }) => id)).not.toContain(leaverId);

      await removeAttendee(host, eventId, leaverId).expect(404);
    });

    it('revives their row when they are added again: their votes count and their nominations reopen, their games stay off the lineup', async () => {
      const { host, leaver, eventId, leaverId, ofOthersGame, ofLeaversGame, scheduledGameId } = await arrangeEvent();
      await removeAttendee(host, eventId, leaverId).expect(200);

      const readded = attendeeEnvelope(
        await addAttendee(host, eventId, {
          userId: leaver.user.id,
          status: EventParticipationStatus.Attending,
        }).expect(201),
        'POST /api/events/:eventId/attendees for a removed user',
      );

      expect(readded.id).toBe(leaverId);
      expect(readded.removedAt).toBeNull();
      expect(voteOf(await readNomination(host, eventId, ofOthersGame.id), leaverId)?.eligible).toBe(true);
      expect((await readNomination(host, eventId, ofLeaversGame.id)).status).toBe(NominationStatus.Open);
      expect(await scheduledGameExists(scheduledGameId)).toBe(false);

      // Their role is back with the row.
      await castVote(leaver, eventId, ofOthersGame.id, VoteType.Against).expect(201);
    });
  });

  describe('not attending', () => {
    it('is out the same way, keeping their role, and attending again brings them back', async () => {
      const { leaver, host, eventId, leaverId, ofOthersGame, ofLeaversGame, scheduledGameId, occurrenceId } =
        await arrangeEvent();

      await rsvp(leaver, eventId, leaverId, EventParticipationStatus.NotAttending).expect(200);

      const dateWhileOut = await summaryOf(host, eventId, occurrenceId);
      expect(dateWhileOut?.available).toBe(0);
      expect(dateWhileOut?.voters).toContainEqual({
        attendeeId: leaverId,
        response: AvailabilityResponse.Available,
        eligible: false,
      });

      expect(voteOf(await readNomination(host, eventId, ofOthersGame.id), leaverId)?.eligible).toBe(false);
      expect((await readNomination(host, eventId, ofOthersGame.id)).status).toBe(NominationStatus.Open);
      expect((await readNomination(host, eventId, ofLeaversGame.id)).status).toBe(NominationStatus.Paused);
      expect(await scheduledGameExists(scheduledGameId)).toBe(false);
      await request(baseUrl).get(`${EVENTS_PATH}/${eventId}`).set(leaver.headers).expect(200);

      await rsvp(leaver, eventId, leaverId, EventParticipationStatus.Attending).expect(200);

      expect(voteOf(await readNomination(host, eventId, ofOthersGame.id), leaverId)?.eligible).toBe(true);
      expect((await readNomination(host, eventId, ofLeaversGame.id)).status).toBe(NominationStatus.Open);
      expect(await scheduledGameExists(scheduledGameId)).toBe(false);
      expect((await summaryOf(host, eventId, occurrenceId))?.available).toBe(1);
    });

    it('refuses a nomination of a game they offered while they are out, and writes nothing', async () => {
      const { host, leaver, eventId, leaverId } = await arrangeEvent();
      const entry = await arrangeListEntry(db.client, eventId, leaver.user.id);

      await rsvp(leaver, eventId, leaverId, EventParticipationStatus.NotAttending).expect(200);

      await nominate(host, eventId, entry).expect(409);
      expect(await db.client.eventGameNomination.count({ where: { suppliedFromId: entry.suppliedById } })).toBe(0);
    });

    it('keeps the lineup of a date that has started, which then no longer holds the game on their offered games', async () => {
      const { leaver, eventId, leaverId } = await arrangeEvent();

      const scheduledOn = async (startDate: Date) =>
        inLineupOf(eventId, await confirmedDate(eventId, startDate), leaver);

      const played = await scheduledOn(new Date(Date.now() - DAY));
      const ahead = await scheduledOn(new Date(Date.now() + DAY));

      await rsvp(leaver, eventId, leaverId, EventParticipationStatus.NotAttending).expect(200);

      expect(await scheduledGameExists(played.id)).toBe(true);
      expect(await scheduledGameExists(ahead.id)).toBe(false);

      await removeGame(leaver, eventId, leaverId, played.entryId).expect(200);
      expect(await scheduledGameExists(played.id)).toBe(true);
    });
  });

  /**
   * A started date keeps its lineup, games nobody is bringing included. A
   * write to the event's dates that puts that lineup ahead again takes them
   * off, since no route does.
   */
  describe('a date write that puts a lineup ahead again', () => {
    it('takes off the games nobody is bringing when a date that has started is moved to a start still to come', async () => {
      const { host, leaver, stayer, eventId, leaverId, stayerId } = await arrangeEvent();
      const occurrenceId = await confirmedDate(eventId, new Date(Date.now() - DAY));
      const leavers = await inLineupOf(eventId, occurrenceId, leaver);
      const offTheList = await inLineupOf(eventId, occurrenceId, stayer);
      const hosts = await inLineupOf(eventId, occurrenceId, host);

      await rsvp(leaver, eventId, leaverId, EventParticipationStatus.NotAttending).expect(200);
      await removeGame(stayer, eventId, stayerId, offTheList.entryId).expect(200);
      expect(await scheduledGameExists(leavers.id)).toBe(true);
      expect(await scheduledGameExists(offTheList.id)).toBe(true);

      const moved = occurrenceEnvelope(
        await request(baseUrl)
          .patch(`${EVENTS_PATH}/${eventId}/occurrences/${occurrenceId}`)
          .set(host.headers)
          .send({ startDate: new Date(Date.now() + DAY).toISOString() })
          .expect(200),
        'PATCH /api/events/:eventId/occurrences/:occurrenceId',
      );

      expect(moved.games.map(({ id }) => id)).toEqual([hosts.id]);
      expect(await scheduledGameExists(leavers.id)).toBe(false);
      expect(await scheduledGameExists(offTheList.id)).toBe(false);

      // The leaver's entry supplies nothing ahead now, so it can come off.
      await removeGame(leaver, eventId, leaverId, leavers.entryId).expect(200);
    });

    it.each([
      {
        write: 'a date added',
        run: (host: AuthenticatedActor, eventId: string) =>
          request(baseUrl)
            .post(`${EVENTS_PATH}/${eventId}/occurrences`)
            .set(host.headers)
            .send({ startDate: new Date(Date.now() + DAY).toISOString() })
            .expect(201),
      },
      {
        write: 'its last date removed',
        run: (host: AuthenticatedActor, eventId: string, occurrenceId: string) =>
          request(baseUrl)
            .delete(`${EVENTS_PATH}/${eventId}/occurrences/${occurrenceId}`)
            .set(host.headers)
            .expect(200),
      },
    ])("takes a game nobody is bringing off the event's own lineup with $write", async ({ run }) => {
      const { host, leaver, eventId, leaverId, scheduledGameId, occurrenceId } = await arrangeEvent();
      // The event's one date has started, so its own lineup is no longer ahead.
      await db.client.eventOccurrence.update({
        where: { id: occurrenceId },
        data: { startDate: new Date(Date.now() - DAY) },
      });
      await db.client.event.update({ where: { id: eventId }, data: { schedulingMode: EventSchedulingMode.MultiDay } });

      await rsvp(leaver, eventId, leaverId, EventParticipationStatus.NotAttending).expect(200);
      expect(await scheduledGameExists(scheduledGameId)).toBe(true);

      await run(host, eventId, occurrenceId);

      expect(await scheduledGameExists(scheduledGameId)).toBe(false);
    });

    /**
     * The same, raced. While a date that has started is being moved, a game
     * is added to its lineup from an entry the move has not seen, and then
     * its supplier leaves, or the entry comes off. Reading the date as
     * started, either would keep the game, so it waits for the move and then
     * reads the date as moved.
     *
     * The barrier holds the date's row, so the move queues on its update of
     * the date, inside its transaction. The game's add does not queue: its key
     * into the date takes FOR KEY SHARE, which the barrier's lock leaves alone.
     */
    describe('raced by a game added and then left with nobody bringing it', () => {
      /** Generous for the reason `household-write-tombstone.spec.ts` gives: a cold request clears several guards first. */
      const REQUEST_REACHES_LOCK_MS = 20_000;

      interface Arrangement {
        readonly leaver: AuthenticatedActor;
        readonly eventId: string;
        readonly leaverId: string;
        readonly entryId: string;
      }

      /** The barrier's own backends, which are never the request under test. */
      const barrierPids = (barrier: Barrier): number[] => [barrier.waiter.pid, barrier.observer.pid];

      /**
       * Fires a request that is expected to block, and keeps hold of it
       * safely. Same shape as the helper in `household-write-tombstone.spec.ts`.
       */
      const fire = (send: () => request.Test) => {
        let outcome: string | undefined;
        const settled = send().then(
          (response) => {
            outcome = `HTTP ${response.status}`;

            return response;
          },
          (error: unknown) => {
            outcome = `it failed: ${error instanceof Error ? error.message : String(error)}`;
            throw error;
          },
        );

        settled.catch(() => undefined);

        return { settled, settledEarly: () => outcome };
      };

      it.each([
        {
          leaving: 'its supplier leaving',
          outcome: 'takes the game off',
          send: ({ leaver, eventId, leaverId }: Arrangement) =>
            rsvp(leaver, eventId, leaverId, EventParticipationStatus.NotAttending),
          status: 200,
          inLineup: false,
        },
        {
          leaving: 'its entry coming off their offered games',
          outcome: 'answers 409, the game being in a lineup still ahead',
          send: ({ leaver, eventId, leaverId, entryId }: Arrangement) => removeGame(leaver, eventId, leaverId, entryId),
          status: 409,
          inLineup: true,
        },
      ])('$leaving waits for the move, then $outcome', async ({ send, status, inLineup }) => {
        const host = await actors.user();
        const leaver = await actors.user();
        const eventId = await createdEventId(host);
        const leaverId = attendeeEnvelope(
          await addAttendee(host, eventId, {
            userId: leaver.user.id,
            status: EventParticipationStatus.Attending,
          }).expect(201),
          'POST /api/events/:eventId/attendees as the host',
        ).id;
        const occurrenceId = await confirmedDate(eventId, new Date(Date.now() - DAY));
        const entry = await arrangeListEntry(db.client, eventId, leaver.user.id);

        const { moved, left, gameId } = await withBarrier(async (barrier) => {
          const { holder } = barrier;

          await holder.begin();
          await expect(
            holder.query('SELECT id FROM event_occurrences WHERE id = $1 FOR NO KEY UPDATE', [occurrenceId]),
          ).resolves.toHaveLength(1);

          // Deliberately not awaited: it is supposed to be stuck.
          const move = fire(() =>
            request(baseUrl)
              .patch(`${EVENTS_PATH}/${eventId}/occurrences/${occurrenceId}`)
              .set(host.headers)
              .send({ startDate: new Date(Date.now() + DAY).toISOString() }),
          );

          const moving = await expectLockWaiter(barrier, {
            heldBy: holder.pid,
            description: 'the move of the date',
            timeoutMs: REQUEST_REACHES_LOCK_MS,
            exclude: barrierPids(barrier),
            settledEarly: move.settledEarly,
          });
          expect(moving.query).toMatch(/UPDATE[\s\S]*event_occurrences/);

          const { id: gameId } = eventGameEnvelope(
            await request(baseUrl)
              .post(`${EVENTS_PATH}/${eventId}/nominations/direct-add`)
              .set(host.headers)
              .send({ ...entry, occurrenceId })
              .expect(201),
            'POST /api/events/:eventId/nominations/direct-add as the host',
          );

          const leaving = fire(() => send({ leaver, eventId, leaverId, entryId: entry.suppliedById }));

          // Queued on the event's row behind the move, which is queued behind
          // the barrier.
          const queued = await expectBackendsQueuedBehind(barrier, {
            heldBy: holder.pid,
            count: 2,
            description: 'the move, and the request behind it',
          });
          expect(queued.map(({ query }) => query)).toContainEqual(
            expect.stringMatching(/FROM events WHERE id = \$1 FOR SHARE/),
          );

          // Released before anything else is asked of the database: both
          // requests are inside interactive transactions on the default 5s
          // budget, and an expired budget surfaces as a 500.
          await holder.rollback();

          return { moved: await move.settled, left: await leaving.settled, gameId };
        });

        expect(moved.status).toBe(200);
        expect(left.status).toBe(status);
        expect(await scheduledGameExists(gameId)).toBe(inLineup);
      });
    });
  });

  describe('which votes count', () => {
    it("counts a vote only while its voter is eligible: under ConfirmedOnly, an invited attendee's is shown and not counted", async () => {
      const host = await actors.user();
      const invitees = [await actors.user(), await actors.user()];
      const eventId = await createdEventId(host, { policy: { gameAdditionMode: GameAdditionMode.RequiresVote } });
      for (const invitee of invitees) {
        await addAttendee(host, eventId, { userId: invitee.user.id }).expect(201);
      }

      const { id: nominationId } = nominationEnvelope(
        await nominate(host, eventId, await arrangeListEntry(db.client, eventId, host.user.id)).expect(201),
        'POST /api/events/:eventId/nominations',
      );
      await castVote(host, eventId, nominationId, VoteType.For).expect(201);
      for (const invitee of invitees) {
        await castVote(invitee, eventId, nominationId, VoteType.Against).expect(201);
      }

      const { nomination, resolution } = resolutionEnvelope(
        await request(baseUrl)
          .post(`${EVENTS_PATH}/${eventId}/nominations/${nominationId}/resolve`)
          .set(host.headers)
          .expect(201),
        'POST /api/events/:eventId/nominations/:nominationId/resolve',
      );

      // Counted as cast, the two invitees' Against votes would have failed it.
      expect(resolution.status).toBe(NominationStatus.Passed);
      expect(resolution.tally).toMatchObject({ forCount: 1, againstCount: 0, totalVotes: 1 });
      expect(nomination.votes.filter((vote) => !vote.eligible)).toHaveLength(2);
    });
  });

  describe('a game an attendee offers', () => {
    it('refuses its removal with 409 while it supplies an open nomination or a game in the lineup, and removes nothing', async () => {
      const { leaver, stayer, eventId, leaverId, ofLeaversGame, scheduledGameId } = await arrangeEvent();
      const { suppliedFromId } = await db.client.eventGameNomination.findUniqueOrThrow({
        where: { id: ofLeaversGame.id },
        select: { suppliedFromId: true },
      });
      const { suppliedById } = await db.client.eventGame.findUniqueOrThrow({
        where: { id: scheduledGameId },
        select: { suppliedById: true },
      });

      // Only someone who could take the game off learns what it supplies.
      await removeGame(stayer, eventId, leaverId, suppliedFromId).expect(403);

      await removeGame(leaver, eventId, leaverId, suppliedFromId).expect(409);
      await removeGame(leaver, eventId, leaverId, suppliedById).expect(409);

      const listed = await listGames(leaver, eventId, leaverId).expect(200);
      expect((listed.body.games as { id: string }[]).map(({ id }) => id)).toEqual(
        expect.arrayContaining([suppliedFromId, suppliedById]),
      );
    });

    it('takes it off the offered games once only closed nominations name it, which keep naming it, and revives the row when it is offered again', async () => {
      const { host, leaver, eventId, leaverId, ofLeaversGame } = await arrangeEvent();
      const { suppliedFromId } = await db.client.eventGameNomination.findUniqueOrThrow({
        where: { id: ofLeaversGame.id },
        select: { suppliedFromId: true },
      });
      await request(baseUrl)
        .patch(`${EVENTS_PATH}/${eventId}/nominations/${ofLeaversGame.id}/withdraw`)
        .set(host.headers)
        .expect(200);

      await removeGame(leaver, eventId, leaverId, suppliedFromId).expect(200);

      const listed = await listGames(leaver, eventId, leaverId).expect(200);
      expect((listed.body.games as { id: string }[]).map(({ id }) => id)).not.toContain(suppliedFromId);
      expect((await readNomination(host, eventId, ofLeaversGame.id)).suppliedFrom.id).toBe(suppliedFromId);

      const { collectionId } = await db.client.eventAttendeeGameList.findUniqueOrThrow({
        where: { id: suppliedFromId },
        select: { collectionId: true },
      });
      const readded = await request(baseUrl)
        .post(`${EVENTS_PATH}/${eventId}/attendees/${leaverId}/games`)
        .set(leaver.headers)
        .send({ collectionId })
        .expect(201);
      expect(readded.body.entry.id).toBe(suppliedFromId);
    });
  });
});
