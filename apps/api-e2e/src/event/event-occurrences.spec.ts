import { GameAdditionMode, NominationStatus, OccurrenceStatus, PlatformType, ScheduledGameRole } from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { expectBackendsQueuedBehind, expectLockWaiter, withBarrier, type Barrier } from '../support/lock-barrier';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { arrangeListEntry } from './event-fixtures';
import { createEventClient, EVENTS_PATH } from './event-request';
import { eventGameEnvelope, listOccurrencesEnvelope, nominationEnvelope, occurrenceEnvelope } from './event-wire';

/**
 * What the occurrence routes serve, over the real routes (#558).
 *
 * Until #558 every occurrence route that serves an occurrence answered 500.
 * The include they share still selected `EventGame` fields a schema change
 * had replaced, and Prisma refuses an invalid include before it sends any
 * SQL, so the routes failed whether or not the event had occurrences.
 * Typecheck missed it because the include was a module constant rather than
 * a fresh literal, and no e2e called the routes.
 *
 * Occurrences, and the game put on one, are written through their routes, so
 * every read below serves rows the API wrote. Only the supplier's game, and
 * its place on their list for the event, are arranged in the database. Each
 * test creates its own event, since an event in the default Fixed scheduling
 * mode holds one occurrence.
 */
describe('event occurrences', () => {
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

  const occurrencesPath = (eventId: string) => `${EVENTS_PATH}/${eventId}/occurrences`;

  const readOccurrence = (actor: AuthenticatedActor, eventId: string, occurrenceId: string) =>
    request(baseUrl)
      .get(`${occurrencesPath(eventId)}/${occurrenceId}`)
      .set(actor.headers);

  const listOccurrences = (actor: AuthenticatedActor, eventId: string) =>
    request(baseUrl).get(occurrencesPath(eventId)).set(actor.headers);

  const addedOccurrence = async (actor: AuthenticatedActor, eventId: string) =>
    occurrenceEnvelope(
      await request(baseUrl).post(occurrencesPath(eventId)).set(actor.headers).send({ label: 'Saturday' }).expect(201),
      'POST /api/events/:eventId/occurrences',
    );

  /** Puts a game from the host's list on the occurrence, under `sortOrder` when one is given. */
  const directAddedGameId = async (
    actor: AuthenticatedActor,
    eventId: string,
    occurrenceId: string,
    sortOrder?: number,
  ) =>
    eventGameEnvelope(
      await request(baseUrl)
        .post(`${EVENTS_PATH}/${eventId}/nominations/direct-add`)
        .set(actor.headers)
        .send({ ...(await arrangeListEntry(db.client, eventId, actor.user.id)), occurrenceId, sortOrder })
        .expect(201),
      'POST /api/events/:eventId/nominations/direct-add with a sort order',
    ).id;

  it('adds an occurrence, lists it, reads it and updates it', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);

    const added = await addedOccurrence(host, eventId);
    // Confirmed: the event is in the default Fixed scheduling mode.
    expect(added).toEqual(
      expect.objectContaining({ eventId, label: 'Saturday', status: OccurrenceStatus.Confirmed, games: [] }),
    );

    const page = listOccurrencesEnvelope(
      await listOccurrences(host, eventId).expect(200),
      'GET /api/events/:eventId/occurrences',
    );
    expect(page.occurrences.map((occurrence) => occurrence.id)).toEqual([added.id]);
    expect(page.total).toBe(1);

    const read = occurrenceEnvelope(
      await readOccurrence(host, eventId, added.id).expect(200),
      'GET /api/events/:eventId/occurrences/:occurrenceId',
    );
    expect(read).toEqual(expect.objectContaining({ id: added.id, label: 'Saturday', games: [] }));

    const updated = occurrenceEnvelope(
      await request(baseUrl)
        .patch(`${occurrencesPath(eventId)}/${added.id}`)
        .set(host.headers)
        .send({ label: 'Saturday evening' })
        .expect(200),
      'PATCH /api/events/:eventId/occurrences/:occurrenceId',
    );
    expect(updated).toEqual(expect.objectContaining({ id: added.id, label: 'Saturday evening', games: [] }));
  });

  it('serves a game put on the occurrence with its platform game, game and platform', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);
    const occurrence = await addedOccurrence(host, eventId);
    const entry = await arrangeListEntry(db.client, eventId, host.user.id);

    const eventGame = eventGameEnvelope(
      await request(baseUrl)
        .post(`${EVENTS_PATH}/${eventId}/nominations/direct-add`)
        .set(host.headers)
        .send({ ...entry, occurrenceId: occurrence.id })
        .expect(201),
      'POST /api/events/:eventId/nominations/direct-add with an occurrence',
    );
    expect(eventGame.occurrenceId).toBe(occurrence.id);

    // The game and platform as stored, for the ids and title the fixture
    // generated. The platform is the seeded tabletop one.
    const stored = await db.client.platformGame.findUniqueOrThrow({
      where: { id: entry.platformGameId },
      select: { gameId: true, platformId: true, game: { select: { title: true } } },
    });
    const expectedGames = [
      {
        id: eventGame.id,
        platformGameId: entry.platformGameId,
        role: ScheduledGameRole.Primary,
        platformGame: {
          id: entry.platformGameId,
          game: { id: stored.gameId, title: stored.game.title, thumbnail: null },
          platform: { id: stored.platformId, name: 'Tabletop', platformType: PlatformType.Tabletop },
        },
      },
    ];

    const read = occurrenceEnvelope(
      await readOccurrence(host, eventId, occurrence.id).expect(200),
      'GET /api/events/:eventId/occurrences/:occurrenceId with a game',
    );
    expect(read.games).toEqual(expectedGames);

    const page = listOccurrencesEnvelope(
      await listOccurrences(host, eventId).expect(200),
      'GET /api/events/:eventId/occurrences with a game',
    );
    expect(page.occurrences.map((listed) => listed.games)).toEqual([expectedGames]);
  });

  it("serves the occurrence's games in the order the host gave them", async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);
    const occurrence = await addedOccurrence(host, eventId);

    // Added in the reverse of their order, so a read that returns them as
    // they were written comes back wrong.
    const second = await directAddedGameId(host, eventId, occurrence.id, 1);
    const first = await directAddedGameId(host, eventId, occurrence.id, 0);

    const read = occurrenceEnvelope(
      await readOccurrence(host, eventId, occurrence.id).expect(200),
      'GET /api/events/:eventId/occurrences/:occurrenceId with two games',
    );
    expect(read.games.map((game) => game.id)).toEqual([first, second]);

    const page = listOccurrencesEnvelope(
      await listOccurrences(host, eventId).expect(200),
      'GET /api/events/:eventId/occurrences with two games',
    );
    expect(page.occurrences.map((listed) => listed.games.map((game) => game.id))).toEqual([[first, second]]);
  });

  it("breaks a tie in the host's order by the game's id", async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);
    const occurrence = await addedOccurrence(host, eventId);

    // No game here is given a sort order, so each takes the default and they
    // all tie, as in any lineup the host leaves unnumbered. Ids are random, so
    // games added in turn may already be in id order, and a read returning
    // ties as they were written would pass. Adding stops once one sorts before
    // an earlier one; twelve in id order by chance is 1 in 479,001,600.
    const inIdOrder = (ids: readonly string[]) => ids.every((id, index) => index === 0 || ids[index - 1] < id);
    const addedIds: string[] = [];
    do {
      addedIds.push(await directAddedGameId(host, eventId, occurrence.id));
    } while (inIdOrder(addedIds) && addedIds.length < 12);
    expect(inIdOrder(addedIds)).toBe(false);

    // The ids are lowercase letters and digits of one length, so the
    // database's order and a string sort agree.
    const byId = [...addedIds].sort();

    const read = occurrenceEnvelope(
      await readOccurrence(host, eventId, occurrence.id).expect(200),
      'GET /api/events/:eventId/occurrences/:occurrenceId with tied games',
    );
    expect(read.games.map((game) => game.id)).toEqual(byId);

    const page = listOccurrencesEnvelope(
      await listOccurrences(host, eventId).expect(200),
      'GET /api/events/:eventId/occurrences with tied games',
    );
    expect(page.occurrences.map((listed) => listed.games.map((game) => game.id))).toEqual([byId]);
  });

  it('cancels a confirmed occurrence, then deletes it', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);
    const occurrence = await addedOccurrence(host, eventId);

    const cancelled = occurrenceEnvelope(
      await request(baseUrl)
        .post(`${occurrencesPath(eventId)}/${occurrence.id}/cancel`)
        .set(host.headers)
        .expect(201),
      'POST /api/events/:eventId/occurrences/:occurrenceId/cancel',
    );
    expect(cancelled).toEqual(
      expect.objectContaining({ id: occurrence.id, status: OccurrenceStatus.Cancelled, cancelledById: host.user.id }),
    );

    const removed = occurrenceEnvelope(
      await request(baseUrl)
        .delete(`${occurrencesPath(eventId)}/${occurrence.id}`)
        .set(host.headers)
        .expect(200),
      'DELETE /api/events/:eventId/occurrences/:occurrenceId',
    );
    expect(removed.id).toBe(occurrence.id);
    // Checked in the database: a read answering 404 would pass just as well
    // if the read scope left cancelled occurrences out.
    expect(await db.client.eventOccurrence.count({ where: { id: occurrence.id } })).toBe(0);
  });

  /**
   * A date removed while a nomination of a game for it is approved (#551).
   *
   * Removing a date clears it from the nominations that name it while holding
   * the date's row, and approving a nomination adds its game to that date's
   * lineup, which waits on the same row. With only the nomination locked,
   * each could wait on the other until Postgres broke the deadlock and one
   * answered 409. Both lock the event's dates first, so whichever comes second
   * waits for the first.
   *
   * The barrier holds one row so the first request queues inside its
   * transaction, then the second is fired and seen queued on the event's row.
   */
  describe('removed while a nomination of a game for it is approved', () => {
    /** Generous for the reason `household-write-tombstone.spec.ts` gives: a cold request clears several guards first. */
    const REQUEST_REACHES_LOCK_MS = 20_000;

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

    /** An event whose host approves each game nominated, with a date, and the host's nomination of a game for it. */
    const arrange = async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host, { policy: { gameAdditionMode: GameAdditionMode.HostApproval } });
      const { id: occurrenceId } = await addedOccurrence(host, eventId);
      const entry = await arrangeListEntry(db.client, eventId, host.user.id);
      const nomination = nominationEnvelope(
        await request(baseUrl)
          .post(`${EVENTS_PATH}/${eventId}/nominations`)
          .set(host.headers)
          .send({ platformGameId: entry.platformGameId, suppliedFromId: entry.suppliedById, occurrenceId })
          .expect(201),
        'POST /api/events/:eventId/nominations',
      );
      expect(nomination.status).toBe(NominationStatus.AwaitingApproval);

      return { host, eventId, occurrenceId, nominationId: nomination.id };
    };

    const approve = (actor: AuthenticatedActor, eventId: string, nominationId: string) =>
      request(baseUrl).post(`${EVENTS_PATH}/${eventId}/nominations/${nominationId}/approve`).set(actor.headers);

    const removeDate = (actor: AuthenticatedActor, eventId: string, occurrenceId: string) =>
      request(baseUrl)
        .delete(`${occurrencesPath(eventId)}/${occurrenceId}`)
        .set(actor.headers);

    it("the approval waits for the removal, then adds the game to the event's own lineup", async () => {
      const { host, eventId, occurrenceId, nominationId } = await arrange();

      const { removed, approved } = await withBarrier(async (barrier) => {
        const { holder } = barrier;

        await holder.begin();
        await expect(
          holder.query('SELECT id FROM event_occurrences WHERE id = $1 FOR NO KEY UPDATE', [occurrenceId]),
        ).resolves.toHaveLength(1);

        // Deliberately not awaited: it is supposed to be stuck.
        const removal = fire(() => removeDate(host, eventId, occurrenceId));

        const removing = await expectLockWaiter(barrier, {
          heldBy: holder.pid,
          description: 'the removal of the date',
          timeoutMs: REQUEST_REACHES_LOCK_MS,
          exclude: barrierPids(barrier),
          settledEarly: removal.settledEarly,
        });
        expect(removing.query).toMatch(/DELETE[\s\S]*event_occurrences/);

        const approval = fire(() => approve(host, eventId, nominationId));

        // Queued on the event's row behind the removal, which is queued behind
        // the barrier.
        const queued = await expectBackendsQueuedBehind(barrier, {
          heldBy: holder.pid,
          count: 2,
          description: 'the removal, and the approval behind it',
        });
        expect(queued.map(({ query }) => query)).toContainEqual(
          expect.stringMatching(/FROM events WHERE id = \$1 FOR SHARE/),
        );

        // Released before anything else is asked of the database: both
        // requests are inside interactive transactions on the default 5s
        // budget, and an expired budget surfaces as a 500.
        await holder.rollback();

        return { removed: await removal.settled, approved: await approval.settled };
      });

      expect(removed.status).toBe(200);
      expect(approved.status).toBe(201);
      expect(nominationEnvelope(approved, 'POST /api/events/:eventId/nominations/:nominationId/approve')).toMatchObject(
        { status: NominationStatus.Approved, occurrenceId: null },
      );
      expect(
        await db.client.eventGame.findMany({ where: { nominationId }, select: { eventId: true, occurrenceId: true } }),
      ).toEqual([{ eventId, occurrenceId: null }]);
    });

    it('the removal waits for the approval, then takes the game off with the date', async () => {
      const { host, eventId, occurrenceId, nominationId } = await arrange();

      const { removed, approved } = await withBarrier(async (barrier) => {
        const { holder } = barrier;

        await holder.begin();
        await expect(
          holder.query('SELECT id FROM event_game_nominations WHERE id = $1 FOR UPDATE', [nominationId]),
        ).resolves.toHaveLength(1);

        // Deliberately not awaited: it is supposed to be stuck.
        const approval = fire(() => approve(host, eventId, nominationId));

        const approving = await expectLockWaiter(barrier, {
          heldBy: holder.pid,
          description: 'the approval of the nomination',
          timeoutMs: REQUEST_REACHES_LOCK_MS,
          exclude: barrierPids(barrier),
          settledEarly: approval.settledEarly,
        });
        expect(approving.query).toMatch(/FROM event_game_nominations WHERE id = \$1 FOR UPDATE/);

        const removal = fire(() => removeDate(host, eventId, occurrenceId));

        // Queued on the event's row behind the approval, which is queued
        // behind the barrier.
        const queued = await expectBackendsQueuedBehind(barrier, {
          heldBy: holder.pid,
          count: 2,
          description: 'the approval, and the removal behind it',
        });
        expect(queued.map(({ query }) => query)).toContainEqual(
          expect.stringMatching(/FROM events WHERE id = \$1 FOR NO KEY UPDATE/),
        );

        // Released promptly, for the reason the test above gives.
        await holder.rollback();

        return { removed: await removal.settled, approved: await approval.settled };
      });

      expect(removed.status).toBe(200);
      expect(approved.status).toBe(201);
      expect(nominationEnvelope(approved, 'POST /api/events/:eventId/nominations/:nominationId/approve')).toMatchObject(
        { status: NominationStatus.Approved, occurrenceId },
      );
      // The date's lineup went with it, and the nomination is the event's now.
      expect(await db.client.eventGame.count({ where: { nominationId } })).toBe(0);
      expect(
        await db.client.eventGameNomination.findUniqueOrThrow({
          where: { id: nominationId },
          select: { status: true, occurrenceId: true },
        }),
      ).toEqual({ status: NominationStatus.Approved, occurrenceId: null });
    });
  });
});
