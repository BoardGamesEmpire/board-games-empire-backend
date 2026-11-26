import {
  EventParticipationStatus,
  EventSchedulingMode,
  GameAdditionMode,
  GameMedium,
  GameRemovalReason,
  NominationStatus,
  OccurrenceStatus,
  Reach,
  VoteType,
} from '@bge/database';
import type { Actors, AuthenticatedActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import request from 'supertest';
import { arrangeCollectionEntry } from '../game-collection/game-collection-fixtures';
import { copyEnvelope, listRevisionsEnvelope, readCollectionEnvelope } from '../game-collection/game-collection-wire';
import { requireBaseUrl } from '../support/e2e-env';
import type { Barrier } from '../support/lock-barrier';
import { expectLockWaiter, withBarrier } from '../support/lock-barrier';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { arrangeOfferedGame } from './event-fixtures';
import { attendeeGamesPath, attendeesPath, createEventClient, EVENTS_PATH, offerGamesPath } from './event-request';
import type { NominationWire, OfferedGameWire, OfferResultWire } from './event-wire';
import {
  attendeeEnvelope,
  listAttendeeGamesEnvelope,
  listAttendeesEnvelope,
  listLineupEnvelope,
  listOfferedGamesEnvelope,
  nominationEnvelope,
  offeredGameEnvelope,
  offerResultsEnvelope,
} from './event-wire';

/**
 * Removing a game from its owner's collection while an event offers it, over
 * the real routes (#1221).
 *
 * A game removed from the collection is one its owner no longer has, so
 * nobody brings it. Every live event that offers it follows:
 *
 * - the offer drops out of the event's offered games, and comes back when the
 *   game is added back;
 * - the nominations of the game that await an outcome pause, keeping their
 *   votes, and reopen when the game is added back, if its owner is in the
 *   event then;
 * - the game leaves the lineup of every date still ahead, and stays off it;
 * - a nomination, a direct add or a batch offer naming it is refused.
 *
 * An event that is deleted, or whose household is deleted, is left as it
 * stands. Each test below arranges the same event: a host, an owner and a
 * stayer, the host having nominated the owner's game, which the stayer voted
 * for, and the game in the event's own lineup.
 */
describe('removing an offered game from the collection (#1221)', () => {
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

  const { createdEventId, listAttendees, listOfferedGames } = createEventClient(baseUrl);

  const COLLECTIONS_PATH = '/api/game-collections';

  /** An offered game: its collection entry, its game, and the offer, which supplies the game. */
  interface Offer {
    readonly collectionId: string;
    readonly platformGameId: string;
    readonly suppliedById: string;
  }

  /** A fresh game in `owner`'s collection, offered by their attendee row on the event. */
  const offerOf = async (eventId: string, owner: AuthenticatedActor): Promise<Offer> => {
    const { collectionId, entryId, platformGameId } = await arrangeOfferedGame(db.client, {
      eventId,
      ownerId: owner.user.id,
    });

    return { collectionId, platformGameId, suppliedById: entryId };
  };

  const addAttendee = (actor: AuthenticatedActor, eventId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(attendeesPath(eventId)).set(actor.headers).send(body);

  /** Adds `actor` to the event as attending, as its host, and answers their attendee id. */
  const addAttending = async (host: AuthenticatedActor, eventId: string, actor: AuthenticatedActor) =>
    attendeeEnvelope(
      await addAttendee(host, eventId, { userId: actor.user.id, status: EventParticipationStatus.Attending }).expect(
        201,
      ),
      'POST /api/events/:eventId/attendees as the host',
    ).id;

  const rsvp = (actor: AuthenticatedActor, eventId: string, attendeeId: string, status: EventParticipationStatus) =>
    request(baseUrl)
      .patch(`${attendeesPath(eventId)}/${attendeeId}/status`)
      .set(actor.headers)
      .send({ status });

  const nominate = (actor: AuthenticatedActor, eventId: string, offer: Offer) =>
    request(baseUrl)
      .post(`${EVENTS_PATH}/${eventId}/nominations`)
      .set(actor.headers)
      .send({ platformGameId: offer.platformGameId, suppliedFromId: offer.suppliedById });

  const directAdd = (actor: AuthenticatedActor, eventId: string, offer: Offer) =>
    request(baseUrl)
      .post(`${EVENTS_PATH}/${eventId}/nominations/direct-add`)
      .set(actor.headers)
      .send({ platformGameId: offer.platformGameId, suppliedById: offer.suppliedById });

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

  const voteOf = (nomination: NominationWire, attendeeId: string) =>
    nomination.votes.find((vote) => vote.attendeeId === attendeeId);

  const removeFromCollection = (owner: AuthenticatedActor, collectionId: string) =>
    request(baseUrl).delete(`${COLLECTIONS_PATH}/${collectionId}`).set(owner.headers);

  /** Removes the offer's game from `owner`'s collection, failing the test unless the removal answers 200. */
  const removed = async (owner: AuthenticatedActor, offer: Pick<Offer, 'collectionId'>) =>
    readCollectionEnvelope(
      await removeFromCollection(owner, offer.collectionId).expect(200),
      'DELETE /api/game-collections/:id as the owner',
    ).collection;

  /** Adds the offer's game back to `owner`'s collection, as the same medium the fixture arranges. */
  const addedBack = async (owner: AuthenticatedActor, offer: Offer) =>
    readCollectionEnvelope(
      await request(baseUrl)
        .post(COLLECTIONS_PATH)
        .set(owner.headers)
        .send({ platformGameId: offer.platformGameId, medium: GameMedium.Physical })
        .expect(201),
      'POST /api/game-collections as the owner',
    ).collection;

  /** The 404 a supply check answers for an offer that supplies nothing, its message telling it from the event's own 404. */
  const supplierNotFound = (gameListId: string) => `Game list entry ${gameListId} not found for this event.`;

  const lineupGameExists = async (id: string) => (await db.client.eventGame.count({ where: { id } })) === 1;

  const DAY = 24 * 60 * 60 * 1000;

  /**
   * An event that votes on its games, with a host, an owner and a stayer, all
   * attending. `owner` is made here unless given.
   *
   * - `offered`: a game the owner offers;
   * - `nomination`: the host's nomination of it, which the stayer voted for;
   * - `lineupGameId`: the game in the event's own lineup, supplied by the
   *   same offer.
   */
  const arrangeEvent = async (options: { owner?: AuthenticatedActor } = {}) => {
    const host = await actors.user();
    const owner = options.owner ?? (await actors.user());
    const stayer = await actors.user();
    const eventId = await createdEventId(host, { policy: { gameAdditionMode: GameAdditionMode.RequiresVote } });
    const ownerAttendeeId = await addAttending(host, eventId, owner);
    const stayerAttendeeId = await addAttending(host, eventId, stayer);

    const offered = await offerOf(eventId, owner);
    const nomination = nominationEnvelope(
      await nominate(host, eventId, offered).expect(201),
      'POST /api/events/:eventId/nominations as the host',
    );
    await castVote(stayer, eventId, nomination.id, VoteType.For).expect(201);

    // The lineup's direct add is closed while the event votes on its games,
    // so the lineup game is arranged as the host's earlier add.
    const { id: lineupGameId } = await db.client.eventGame.create({
      data: { eventId, platformGameId: offered.platformGameId, suppliedById: offered.suppliedById },
      select: { id: true },
    });

    return { host, owner, stayer, eventId, ownerAttendeeId, stayerAttendeeId, offered, nomination, lineupGameId };
  };

  /**
   * The offers each read serves, as sorted ids: the event's offered games and
   * their total, the attendee's own route and its total, and the attendee's
   * games embedded in the attendee list.
   */
  const offerReads = async (host: AuthenticatedActor, eventId: string, attendeeId: string) => {
    const sortedIds = (games: readonly OfferedGameWire[]) => games.map(({ id }) => id).sort();

    const event = listOfferedGamesEnvelope(
      await listOfferedGames(host, eventId).expect(200),
      'GET /api/events/:eventId/offered-games as the host',
    );
    const perAttendee = listAttendeeGamesEnvelope(
      await request(baseUrl).get(attendeeGamesPath(eventId, attendeeId)).set(host.headers).expect(200),
      'GET /api/events/:eventId/attendees/:attendeeId/games as the host',
    );
    const { attendees } = listAttendeesEnvelope(
      await listAttendees(host, eventId).expect(200),
      'GET /api/events/:eventId/attendees as the host',
    );
    const embedded = attendees.find(({ id }) => id === attendeeId) as unknown as
      { availableGames: OfferedGameWire[] } | undefined;

    return {
      event: { ids: sortedIds(event.offeredGames), total: event.total },
      perAttendee: { ids: sortedIds(perAttendee.games), total: perAttendee.total },
      embedded: embedded === undefined ? undefined : sortedIds(embedded.availableGames),
    };
  };

  it("hides the offer from the event's offered games, the per-attendee route and the attendee embed, totals included, and shows it again once the game is added back (#1221)", async () => {
    const { host, owner, eventId, ownerAttendeeId, offered } = await arrangeEvent();
    const kept = await offerOf(eventId, owner);
    const both = [offered.suppliedById, kept.suppliedById].sort();
    const shown = (ids: string[]) => ({
      event: { ids, total: ids.length },
      perAttendee: { ids, total: ids.length },
      embedded: ids,
    });
    expect(await offerReads(host, eventId, ownerAttendeeId)).toEqual(shown(both));

    const answer = await removed(owner, offered);
    expect(answer.id).toBe(offered.collectionId);
    expect(answer.deletedAt).not.toBeNull();

    expect(await offerReads(host, eventId, ownerAttendeeId)).toEqual(shown([kept.suppliedById]));
    // The offer itself stays, to supply the game again once it is back.
    expect(
      await db.client.eventAttendeeGameList.findUniqueOrThrow({
        where: { id: offered.suppliedById },
        select: { removedAt: true },
      }),
    ).toEqual({ removedAt: null });

    // The add-back brings the same entry back, not a new one.
    const back = await addedBack(owner, offered);
    expect(back.id).toBe(offered.collectionId);
    expect(back.deletedAt).toBeNull();

    expect(await offerReads(host, eventId, ownerAttendeeId)).toEqual(shown(both));
  });

  it('pauses the nomination of the removed game, keeping its votes, and reopens it as Open when the game is added back (#1221)', async () => {
    const { host, owner, eventId, stayerAttendeeId, offered, nomination } = await arrangeEvent();
    expect(nomination.status).toBe(NominationStatus.Open);

    await removed(owner, offered);

    const paused = await readNomination(host, eventId, nomination.id);
    expect(paused.status).toBe(NominationStatus.Paused);
    expect(paused.pausedFrom).toBe(NominationStatus.Open);
    expect(voteOf(paused, stayerAttendeeId)).toMatchObject({ voteType: VoteType.For, eligible: true });

    // A paused nomination cannot be resolved.
    await request(baseUrl)
      .post(`${EVENTS_PATH}/${eventId}/nominations/${nomination.id}/resolve`)
      .set(host.headers)
      .expect(400);

    await addedBack(owner, offered);

    const reopened = await readNomination(host, eventId, nomination.id);
    expect(reopened.status).toBe(NominationStatus.Open);
    expect(reopened.pausedFrom).toBeNull();
    expect(voteOf(reopened, stayerAttendeeId)).toMatchObject({ voteType: VoteType.For, eligible: true });
  });

  // The copy route removes the entry with its last owned copy, through the
  // same write runner, so the entry's offers follow as they do when the
  // entry itself is removed (#1231, #1221).
  it("removing the entry's last copy through the copy route pauses its nominations, as removing the entry does (#1231)", async () => {
    const { host, owner, eventId, ownerAttendeeId, stayerAttendeeId, offered, nomination } = await arrangeEvent();
    const { id: copyId } = await db.client.collectionCopy.findFirstOrThrow({
      where: { entryId: offered.collectionId },
      select: { id: true },
    });

    const removedCopy = copyEnvelope(
      await request(baseUrl)
        .delete(`${COLLECTIONS_PATH}/${offered.collectionId}/copies/${copyId}`)
        .query({ reason: GameRemovalReason.Sold })
        .set(owner.headers)
        .expect(200),
      'DELETE /api/game-collections/:id/copies/:copyId as the owner',
    );
    expect(removedCopy).toMatchObject({ id: copyId, removedAt: expect.any(String) });

    const paused = await readNomination(host, eventId, nomination.id);
    expect(paused.status).toBe(NominationStatus.Paused);
    expect(paused.pausedFrom).toBe(NominationStatus.Open);
    expect(voteOf(paused, stayerAttendeeId)).toMatchObject({ voteType: VoteType.For, eligible: true });
    expect((await offerReads(host, eventId, ownerAttendeeId)).event.ids).not.toContain(offered.suppliedById);

    // Adding a copy back acquires the entry again, and reopens the nomination.
    await request(baseUrl)
      .post(`${COLLECTIONS_PATH}/${offered.collectionId}/copies`)
      .set(owner.headers)
      .send({})
      .expect(201);
    expect((await readNomination(host, eventId, nomination.id)).status).toBe(NominationStatus.Open);
  });

  // A copy removal keeps what the copy said before as a revision. Restoring
  // it makes the copy owned again, so the entry comes back through the same
  // write runner, and its offers resume as they do on an add-back (#1231,
  // #1221).
  it('removing a copy keeps what it said before, so restoring that revision makes it owned again and brings the entry back, resuming its offers (#1221)', async () => {
    const { host, owner, eventId, ownerAttendeeId, offered, nomination } = await arrangeEvent();
    const copiesPath = `${COLLECTIONS_PATH}/${offered.collectionId}/copies`;
    const { id: copyId } = await db.client.collectionCopy.findFirstOrThrow({
      where: { entryId: offered.collectionId },
      select: { id: true },
    });

    await request(baseUrl)
      .delete(`${copiesPath}/${copyId}`)
      .query({ reason: GameRemovalReason.Sold })
      .set(owner.headers)
      .expect(200);
    expect((await readNomination(host, eventId, nomination.id)).status).toBe(NominationStatus.Paused);

    const [beforeRemoval] = listRevisionsEnvelope(
      await request(baseUrl).get(`${copiesPath}/${copyId}/revisions`).set(owner.headers).expect(200),
      'GET /api/game-collections/:id/copies/:copyId/revisions as the owner',
    );
    expect(beforeRemoval?.values.removedAt).toBeNull();

    const restoredCopy = copyEnvelope(
      await request(baseUrl)
        .post(`${copiesPath}/${copyId}/revisions/${beforeRemoval?.id}/restore`)
        .set(owner.headers)
        .expect(200),
      'POST /api/game-collections/:id/copies/:copyId/revisions/:revisionId/restore as the owner',
    );
    expect(restoredCopy).toMatchObject({ id: copyId, removedAt: null });

    const reopened = await readNomination(host, eventId, nomination.id);
    expect(reopened.status).toBe(NominationStatus.Open);
    expect(reopened.pausedFrom).toBeNull();
    expect((await offerReads(host, eventId, ownerAttendeeId)).event.ids).toContain(offered.suppliedById);
  });

  it('takes the game off the lineup still ahead and keeps it off after the add-back (#1221)', async () => {
    const { host, owner, eventId, offered, lineupGameId } = await arrangeEvent();
    // A date that has started keeps its lineup, the game included. A date
    // still to come keeps the event's own lineup ahead.
    await db.client.event.update({ where: { id: eventId }, data: { schedulingMode: EventSchedulingMode.MultiDay } });
    const { id: startedId } = await db.client.eventOccurrence.create({
      data: { eventId, status: OccurrenceStatus.Confirmed, startDate: new Date(Date.now() - DAY) },
      select: { id: true },
    });
    await db.client.eventOccurrence.create({ data: { eventId, status: OccurrenceStatus.Proposed } });
    const { id: playedId } = await db.client.eventGame.create({
      data: { occurrenceId: startedId, platformGameId: offered.platformGameId, suppliedById: offered.suppliedById },
      select: { id: true },
    });

    const lineupIds = async () =>
      listLineupEnvelope(
        await request(baseUrl).get(`${EVENTS_PATH}/${eventId}/lineup`).set(host.headers).expect(200),
        'GET /api/events/:eventId/lineup as the host',
      )
        .lineup.map(({ id }) => id)
        .sort();

    expect(await lineupIds()).toEqual([playedId, lineupGameId].sort());

    await removed(owner, offered);

    expect(await lineupIds()).toEqual([playedId]);

    await addedBack(owner, offered);

    expect(await lineupIds()).toEqual([playedId]);
    expect(await lineupGameExists(lineupGameId)).toBe(false);
  });

  it('refuses a nomination or a direct add naming the removed game with 404 (#1221)', async () => {
    const { host, owner, stayer, eventId, offered } = await arrangeEvent();
    // A direct add needs an event that adds games directly.
    const directEventId = await createdEventId(host, { policy: { gameAdditionMode: GameAdditionMode.Direct } });
    await addAttending(host, directEventId, owner);
    const direct = await offerOf(directEventId, owner);

    await removed(owner, offered);
    await removed(owner, direct);

    const nominated = await nominate(stayer, eventId, offered).expect(404);
    expect(nominated.body.message).toBe(supplierNotFound(offered.suppliedById));
    // Only the host's nomination from before the removal names it.
    expect(await db.client.eventGameNomination.count({ where: { suppliedFromId: offered.suppliedById } })).toBe(1);

    const added = await directAdd(host, directEventId, direct).expect(404);
    expect(added.body.message).toBe(supplierNotFound(direct.suppliedById));
    expect(await db.client.eventGame.count({ where: { suppliedById: direct.suppliedById } })).toBe(0);
  });

  it('refuses the removed game in a batch offer as removedFromCollection (#1221)', async () => {
    const { owner, eventId, ownerAttendeeId, offered } = await arrangeEvent();
    // Still offered when removed: its live offer row doesn't make it alreadyOffered.
    await removed(owner, offered);
    const neverOffered = await arrangeCollectionEntry(db.client, owner.user.id, Reach.Private);
    await removed(owner, { collectionId: neverOffered });
    const live = await arrangeCollectionEntry(db.client, owner.user.id, Reach.Private);

    const results = offerResultsEnvelope(
      await request(baseUrl)
        .post(offerGamesPath(eventId, ownerAttendeeId))
        .set(owner.headers)
        .send({
          items: [{ collectionId: offered.collectionId }, { collectionId: neverOffered }, { collectionId: live }],
        })
        .expect(200),
      'POST /api/events/:eventId/attendees/:attendeeId/games/batch as the owner',
    );

    const outcomes = (rows: readonly OfferResultWire[]) =>
      rows.map((row) => [row.collectionId, row.outcome === 'refused' ? row.reason : row.outcome]);
    expect(outcomes(results)).toEqual([
      [offered.collectionId, 'removedFromCollection'],
      [neverOffered, 'removedFromCollection'],
      [live, 'added'],
    ]);
    expect(
      await db.client.eventAttendeeGameList.count({
        where: { attendeeId: ownerAttendeeId, collectionId: neverOffered },
      }),
    ).toBe(0);
  });

  it('keeps the nomination paused when the game is added back while its supplier is not attending, and reopens it once they attend again (#1221)', async () => {
    const { host, owner, eventId, ownerAttendeeId, offered, nomination } = await arrangeEvent();
    const statusOf = async () => (await readNomination(host, eventId, nomination.id)).status;

    await rsvp(owner, eventId, ownerAttendeeId, EventParticipationStatus.NotAttending).expect(200);
    expect(await statusOf()).toBe(NominationStatus.Paused);

    await removed(owner, offered);
    expect(await statusOf()).toBe(NominationStatus.Paused);

    await addedBack(owner, offered);
    expect(await statusOf()).toBe(NominationStatus.Paused);

    await rsvp(owner, eventId, ownerAttendeeId, EventParticipationStatus.Attending).expect(200);
    expect(await statusOf()).toBe(NominationStatus.Open);
  });

  it('keeps the nomination paused when the supplier attends again while the game is still removed (#1221)', async () => {
    const { host, owner, eventId, ownerAttendeeId, offered, nomination } = await arrangeEvent();

    await rsvp(owner, eventId, ownerAttendeeId, EventParticipationStatus.NotAttending).expect(200);
    await removed(owner, offered);

    await rsvp(owner, eventId, ownerAttendeeId, EventParticipationStatus.Attending).expect(200);

    const paused = await readNomination(host, eventId, nomination.id);
    expect(paused.status).toBe(NominationStatus.Paused);
    expect(paused.pausedFrom).toBe(NominationStatus.Open);

    // The removal is what holds it now: adding the game back reopens it.
    await addedBack(owner, offered);
    expect((await readNomination(host, eventId, nomination.id)).status).toBe(NominationStatus.Open);
  });

  it('pauses at a live event and leaves an event whose household was deleted untouched (#1221)', async () => {
    // The household is arranged before the owner's first request, so their
    // grants on it are in place when the ability cache first reads them.
    const owner = await actors.user();
    const { household } = await actors.householdWithMembers({ owner, members: [] });
    const { host, eventId, offered, nomination } = await arrangeEvent({ owner });

    // The same collection entry, offered and nominated at the owner's household event too.
    const householdEventId = await createdEventId(owner, {
      householdId: household.id,
      policy: { gameAdditionMode: GameAdditionMode.RequiresVote },
    });
    const { id: ownerHouseholdAttendeeId } = await db.client.eventAttendee.findUniqueOrThrow({
      where: { eventId_userId: { eventId: householdEventId, userId: owner.user.id } },
      select: { id: true },
    });
    const { id: householdOfferId } = offeredGameEnvelope(
      await request(baseUrl)
        .post(attendeeGamesPath(householdEventId, ownerHouseholdAttendeeId))
        .set(owner.headers)
        .send({ collectionId: offered.collectionId })
        .expect(201),
      'POST /api/events/:eventId/attendees/:attendeeId/games as the owner',
    );
    const atHousehold = nominationEnvelope(
      await nominate(owner, householdEventId, { ...offered, suppliedById: householdOfferId }).expect(201),
      'POST /api/events/:eventId/nominations at the household event',
    );
    expect(atHousehold.status).toBe(NominationStatus.Open);

    await request(baseUrl).delete(`/api/households/${household.id}`).set(owner.headers).expect(200);

    await removed(owner, offered);

    expect((await readNomination(host, eventId, nomination.id)).status).toBe(NominationStatus.Paused);
    // The household event can't be read since its household was deleted, so
    // its nomination is read from the database.
    expect(
      await db.client.eventGameNomination.findUniqueOrThrow({
        where: { id: atHousehold.id },
        select: { status: true, pausedFrom: true },
      }),
    ).toEqual({ status: NominationStatus.Open, pausedFrom: null });
  });

  /**
   * The same, raced. A removal and a write that changes what the entry
   * supplies take turns on the entry's row: the removal's FOR UPDATE of it
   * (`lockEntry`, #1231), a supply check's FOR SHARE (`lockSupplier`), and an
   * attendee's coming back (`syncSuppliedGames`). Whichever comes second
   * waits, then reads what the first committed.
   *
   * The barrier stands in for one side by holding the lock that side's
   * transaction takes, and the request under test runs over its route.
   */
  describe('raced', () => {
    /** Generous for the reason `household-write-tombstone.spec.ts` gives: a cold request clears several guards first. */
    const REQUEST_REACHES_LOCK_MS = 20_000;

    /** Under the 5s budget of the transaction the request waits behind, which a longer wait would outlive. */
    const REMOVAL_REACHES_LOCK_MS = 4_000;

    /** The barrier's own backends, which are never the request under test. */
    const barrierPids = (barrier: Barrier): number[] => [barrier.waiter.pid, barrier.observer.pid];

    /**
     * Fires a request that is expected to block, and keeps hold of it
     * safely. Same shape as the helper in `event-attendee-removal.spec.ts`.
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

    it('a removal racing a nomination of the same game: the nomination waits for the removal and is refused, or commits first and is paused (#1221)', async () => {
      const { host, owner, eventId } = await arrangeEvent();

      // The removal first: the barrier's UPDATE of the entry's row holds it
      // as the removal's first lock does, and the nomination's supply check
      // waits on it.
      const first = await offerOf(eventId, owner);
      const refused = await withBarrier(async (barrier) => {
        const { holder } = barrier;

        await holder.begin();
        await expect(
          holder.query('UPDATE game_collections SET deleted_at = now() WHERE id = $1 RETURNING id', [
            first.collectionId,
          ]),
        ).resolves.toHaveLength(1);

        // Deliberately not awaited: it is supposed to be stuck.
        const nomination = fire(() => nominate(host, eventId, first));

        const nominating = await expectLockWaiter(barrier, {
          heldBy: holder.pid,
          description: 'the nomination of the game being removed',
          timeoutMs: REQUEST_REACHES_LOCK_MS,
          exclude: barrierPids(barrier),
          settledEarly: nomination.settledEarly,
        });
        expect(nominating.query).toMatch(/FOR SHARE OF l, a, c/);

        // Committed before anything else is asked of the database: the
        // nomination is inside an interactive transaction on the default 5s
        // budget, and an expired budget surfaces as a 500.
        await holder.commit();

        return nomination.settled;
      });

      expect(refused.status).toBe(404);
      expect(refused.body.message).toBe(supplierNotFound(first.suppliedById));
      expect(await db.client.eventGameNomination.count({ where: { suppliedFromId: first.suppliedById } })).toBe(0);

      // The first entry is removed already, so removing it again answers 404
      // and changes nothing (#1221). It also warms the owner's session and the
      // removal's route before the half below, where the removal must reach
      // its lock inside the parked nomination's transaction budget.
      await removeFromCollection(owner, first.collectionId).expect(404);

      // The nomination first. The barrier holds the event's row, so the
      // nomination stops between its supply check, which holds the entry's
      // row as a share, and its share of the event. The removal's first
      // lock, its FOR UPDATE of the entry's row (#1231), then waits on the
      // nomination itself, not on the barrier.
      const second = await offerOf(eventId, owner);
      const { created, removal } = await withBarrier(async (barrier) => {
        const { holder } = barrier;

        await holder.begin();
        await expect(holder.query('SELECT id FROM events WHERE id = $1 FOR UPDATE', [eventId])).resolves.toHaveLength(
          1,
        );

        const nomination = fire(() => nominate(host, eventId, second));

        const nominating = await expectLockWaiter(barrier, {
          heldBy: holder.pid,
          description: 'the nomination, past its supply check',
          timeoutMs: REQUEST_REACHES_LOCK_MS,
          exclude: barrierPids(barrier),
          settledEarly: nomination.settledEarly,
        });
        expect(nominating.query).toMatch(/FROM events WHERE id = \$1 FOR SHARE/);

        const removing = fire(() => removeFromCollection(owner, second.collectionId));

        // Bounded by the parked nomination's transaction, on Prisma's default
        // 5s budget (#1221): a removal slower than this fails here, with the
        // waiter's own message, rather than as the nomination's 500 later.
        const waiting = await expectLockWaiter(barrier, {
          heldBy: nominating.pid,
          description: 'the removal of the nominated game',
          timeoutMs: REMOVAL_REACHES_LOCK_MS,
          exclude: barrierPids(barrier),
          settledEarly: removing.settledEarly,
        });
        expect(waiting.query).toMatch(/FROM game_collections\s+WHERE id = \$1\s+FOR UPDATE/);

        // Released before anything else is asked of the database, as above.
        await holder.rollback();

        return { created: await nomination.settled, removal: await removing.settled };
      });

      expect(created.status).toBe(201);
      expect(removal.status).toBe(200);

      const paused = await readNomination(
        host,
        eventId,
        nominationEnvelope(created, 'POST /api/events/:eventId/nominations behind the barrier').id,
      );
      expect(paused.status).toBe(NominationStatus.Paused);
      expect(paused.pausedFrom).toBe(NominationStatus.Open);
    });

    it("a supplier coming back while their game's removal is in flight waits for it and keeps the nomination paused (#1221)", async () => {
      const { host, owner, eventId, ownerAttendeeId, offered, nomination } = await arrangeEvent();
      await rsvp(owner, eventId, ownerAttendeeId, EventParticipationStatus.NotAttending).expect(200);
      expect((await readNomination(host, eventId, nomination.id)).status).toBe(NominationStatus.Paused);

      // The barrier's UPDATE of the entry's row holds it as the removal's
      // first lock does. Coming back resumes the supplier's nominations only
      // after holding their offers' collection entries as shares, so it
      // waits, then reads the game removed.
      const back = await withBarrier(async (barrier) => {
        const { holder } = barrier;

        await holder.begin();
        await expect(
          holder.query('UPDATE game_collections SET deleted_at = now() WHERE id = $1 RETURNING id', [
            offered.collectionId,
          ]),
        ).resolves.toHaveLength(1);

        const coming = fire(() => rsvp(owner, eventId, ownerAttendeeId, EventParticipationStatus.Attending));

        const waiting = await expectLockWaiter(barrier, {
          heldBy: holder.pid,
          description: 'the supplier coming back',
          timeoutMs: REQUEST_REACHES_LOCK_MS,
          exclude: barrierPids(barrier),
          settledEarly: coming.settledEarly,
        });
        expect(waiting.query).toMatch(/ORDER BY c\.id\s+FOR SHARE OF c/);

        // Committed before anything else is asked of the database: the RSVP
        // is inside an interactive transaction on the default 5s budget.
        await holder.commit();

        return coming.settled;
      });

      expect(back.status).toBe(200);

      const paused = await readNomination(host, eventId, nomination.id);
      expect(paused.status).toBe(NominationStatus.Paused);
      expect(paused.pausedFrom).toBe(NominationStatus.Open);
    });
  });
});
