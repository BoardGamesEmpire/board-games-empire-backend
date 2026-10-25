import { Reach } from '@bge/database';
import { createActors, type Actors } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * A game's player count and play time are ranges, read from minimum to
 * maximum, and a search filter matches against them (#869). A PATCH may send
 * one end alone, so the server holds it to the end already stored rather
 * than storing a range that runs backwards.
 */
describe('game ranges', () => {
  const baseUrl = requireBaseUrl(process.env);
  const GAMES_PATH = '/api/games';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const storedRanges = (id: string) =>
    db.client.game.findUniqueOrThrow({
      where: { id },
      select: { minPlayers: true, maxPlayers: true, minPlayTime: true, maxPlayTime: true },
    });

  it('refuses one end that would run past the other end already stored, and stores nothing', async () => {
    const creator = await actors.user();
    const { id } = await db.client.game.create({
      data: {
        title: 'Ranged prototype',
        minPlayers: 2,
        maxPlayers: 4,
        minPlayTime: 60,
        maxPlayTime: 120,
        reach: Reach.Public,
        createdById: creator.user.id,
      },
      select: { id: true },
    });
    const update = (body: object) => request(baseUrl).patch(`${GAMES_PATH}/${id}`).set(creator.headers).send(body);

    const shortened = await update({ maxPlayTime: 30 }).expect(400);
    expect(shortened.body.message).toBe('minPlayTime (60) must not be more than maxPlayTime (30)');

    const crowded = await update({ minPlayers: 5 }).expect(400);
    expect(crowded.body.message).toBe('minPlayers (5) must not be more than maxPlayers (4)');

    expect(await storedRanges(id)).toEqual({ minPlayers: 2, maxPlayers: 4, minPlayTime: 60, maxPlayTime: 120 });

    // An end equal to the stored one is in order, and null clears an end.
    await update({ maxPlayTime: 60 }).expect(200);
    await update({ minPlayers: null, maxPlayers: 1 }).expect(200);
    expect(await storedRanges(id)).toEqual({ minPlayers: null, maxPlayers: 1, minPlayTime: 60, maxPlayTime: 60 });
  });
});
