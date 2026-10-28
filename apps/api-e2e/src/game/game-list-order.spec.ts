import { Reach } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { listGamesEnvelope } from './game-wire';

/**
 * `GET /games?sort=newest` lists the games most recently added to the game
 * catalog first, and the game id decides a tie. The set is the one the title
 * order lists: the sort reorders it and never widens it (#959).
 */
describe('game list order', () => {
  const baseUrl = requireBaseUrl(process.env);
  const GAMES_PATH = '/api/games';

  let db: TestDatabase;
  let actors: Actors;

  let creator: SessionActor;
  let latest: { id: string };
  let tiedA: { id: string };
  let tiedB: { id: string };
  let strangers: { id: string };

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const addGame = (title: string, createdById: string, createdAt: string) =>
    db.client.game.create({
      data: { title, reach: Reach.Private, createdById, createdAt: new Date(createdAt) },
      select: { id: true },
    });

  // Built per test, because the isolation setup resets the database before
  // each one. Dated 2099, so these are newer than anything else on the server.
  // The newest game's title sorts last, so a list that fell back to title
  // order would fail the newest-first tests whatever ids the tied games get.
  // The tied pair shares a title as well as a time, so the id breaks the tie
  // in both orders: descending when newest, ascending by title.
  beforeEach(async () => {
    const [owner, stranger] = await Promise.all([actors.user(), actors.user()]);
    creator = owner;

    [latest, tiedA, tiedB, strangers] = await Promise.all([
      addGame('Zephyr, added last', owner.user.id, '2099-01-03T00:00:00.000Z'),
      addGame('Birch, tied', owner.user.id, '2099-01-02T00:00:00.000Z'),
      addGame('Birch, tied', owner.user.id, '2099-01-02T00:00:00.000Z'),
      addGame("A stranger's, the newest of all", stranger.user.id, '2099-12-31T00:00:00.000Z'),
    ]);
  });

  /** The message a refusal carries, so a surprise reads as a diff rather than as a bare status. */
  const messageOf = (response: { body: unknown }) => (response.body as { message?: unknown } | null)?.message;

  const list = async (query: string) =>
    listGamesEnvelope(
      await request(baseUrl).get(`${GAMES_PATH}?${query}`).set(creator.headers).expect(200),
      `GET ${GAMES_PATH}?${query}`,
    ).games.map((game) => game.id);

  /** The tied pair's ids, ascending. */
  const tiedAscending = () => [tiedA.id, tiedB.id].sort();

  it('lists the games most recently added first, the id deciding a tie', async () => {
    const ids = await list('sort=newest&limit=3');

    expect(ids).toEqual([latest.id, ...tiedAscending().reverse()]);
  });

  it('pages newest first, a tied pair split across the boundary in id order', async () => {
    const [first, second] = [await list('sort=newest&limit=2&page=1'), await list('sort=newest&limit=2&page=2')];

    expect([...first, ...second]).toEqual([latest.id, ...tiedAscending().reverse()]);
    expect(await list('sort=newest&limit=2&page=1')).toEqual(first);
  });

  it("keeps a stranger's newer private game out of the newest list", async () => {
    expect(await list('sort=newest&limit=100')).not.toContain(strangers.id);
  });

  it('answers the same page for sort=title as for no sort, the id deciding a tie', async () => {
    const byTitle = await list('sort=title&limit=100');

    expect(byTitle).toEqual([...tiedAscending(), latest.id]);
    expect(await list('limit=100')).toEqual(byTitle);
  });

  it('refuses a sort it does not know, naming the allowed values', async () => {
    const response = await request(baseUrl).get(`${GAMES_PATH}?sort=oldest`).set(creator.headers).expect(400);

    expect(messageOf(response)).toEqual([expect.stringMatching(/^sort must be one of the following values/)]);
    expect(String(messageOf(response))).toMatch(/title/);
    expect(String(messageOf(response))).toMatch(/newest/);
  });
});
