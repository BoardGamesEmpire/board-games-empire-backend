import { GameMedium } from '@bge/database';
import type { Actors, AuthenticatedActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { arrangePlatformGame } from '../list/list-fixtures';
import { requireBaseUrl } from '../support/e2e-env';
import { expectLockWaiter, withBarrier } from '../support/lock-barrier';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { readCollectionEnvelope } from './game-collection-wire';

/**
 * Two first adds of one game, raced (#1231). Neither finds an entry to lock,
 * so both insert one, and the entry's unique identity lets only the first
 * stand. The second insert waits for the first to commit, then fails; the
 * add then runs its transaction once more, finds the entry the other made,
 * still owned, and adds no copy. A replayed add stays harmless under a race.
 *
 * The barrier stands in for the add that inserts first: it holds the entry
 * and its copy uncommitted, and the add under test runs over its route.
 */
describe('a first add racing another of the same game (#1231)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const COLLECTIONS_PATH = '/api/game-collections';

  /** Generous for the reason `household-write-tombstone.spec.ts` gives: a cold request clears several guards first. */
  const REQUEST_REACHES_LOCK_MS = 20_000;

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const add = (owner: AuthenticatedActor, platformGameId: string) =>
    request(baseUrl).post(COLLECTIONS_PATH).set(owner.headers).send({ platformGameId, medium: GameMedium.Physical });

  /**
   * Fires a request that is expected to block, and keeps hold of it
   * safely. Same shape as the helper in `event-collection-removal.spec.ts`.
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

  it('ends with one entry and one copy, and answers the entry the other add made', async () => {
    const owner = await actors.user();
    const { platformGameId } = await arrangePlatformGame(db.client);
    // Warms the owner's session and the route, so the add under test reaches
    // its insert well inside the barrier's wait.
    await add(owner, (await arrangePlatformGame(db.client)).platformGameId).expect(201);

    const entryId = `e2e-race-${randomUUID()}`;
    const raced = await withBarrier(async (barrier) => {
      const { holder } = barrier;

      await holder.begin();
      await holder.query(
        `INSERT INTO game_collections (id, user_id, platform_game_id, medium, reach, updated_at)
         VALUES ($1, $2, $3, 'Physical', 'Private', now())`,
        [entryId, owner.user.id, platformGameId],
      );
      await holder.query('INSERT INTO collection_copies (id, entry_id, updated_at) VALUES ($1, $2, now())', [
        `e2e-race-copy-${randomUUID()}`,
        entryId,
      ]);

      // Deliberately not awaited: it is supposed to be stuck.
      const adding = fire(() => add(owner, platformGameId));

      const waiting = await expectLockWaiter(barrier, {
        heldBy: holder.pid,
        description: 'the add of a game another add is inserting',
        timeoutMs: REQUEST_REACHES_LOCK_MS,
        exclude: [barrier.waiter.pid, barrier.observer.pid],
        settledEarly: adding.settledEarly,
      });
      expect(waiting.query).toMatch(/INSERT INTO [^(]*game_collections/);

      // Committed before anything else is asked of the database: the add
      // waits inside an interactive transaction on the default 5s budget.
      await holder.commit();

      return adding.settled;
    });

    expect(raced.status).toBe(201);
    expect(readCollectionEnvelope(raced, `POST ${COLLECTIONS_PATH} behind the barrier`).collection).toMatchObject({
      id: entryId,
      quantity: 1,
    });
    expect(await db.client.gameCollection.count({ where: { userId: owner.user.id, platformGameId } })).toBe(1);
    expect(await db.client.collectionCopy.count({ where: { entryId } })).toBe(1);
  });
});
