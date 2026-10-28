import { Reach } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { randomGamesEnvelope } from './game-wire';

/**
 * `GET /games/random` answers up to `size` games picked uniformly from the set
 * `GET /games` lists for the caller, each as the game summary. A new member's
 * home page falls back to it, so it never shows a game the caller could
 * not open (#961).
 */
describe('random games', () => {
  const baseUrl = requireBaseUrl(process.env);
  const RANDOM_PATH = '/api/games/random';

  let db: TestDatabase;
  let actors: Actors;

  let caller: SessionActor;
  let own: { id: string };
  let publicGame: { id: string };
  let strangers: { id: string };

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const addGame = (title: string, createdById: string, reach: Reach) =>
    db.client.game.create({ data: { title, reach, createdById }, select: { id: true } });

  // Built per test, because the isolation setup resets the database before
  // each one.
  beforeEach(async () => {
    const [self, other, stranger] = await Promise.all([actors.user(), actors.user(), actors.user()]);
    caller = self;

    [own, publicGame, strangers] = await Promise.all([
      addGame("The caller's own", self.user.id, Reach.Private),
      addGame("Another user's, Public", other.user.id, Reach.Public),
      addGame("A stranger's, Private", stranger.user.id, Reach.Private),
    ]);
  });

  /** The message a refusal carries, so a surprise reads as a diff rather than as a bare status. */
  const messageOf = (response: { body: unknown }) => (response.body as { message?: unknown } | null)?.message;

  const sample = async (query = '') => {
    const path = query === '' ? RANDOM_PATH : `${RANDOM_PATH}?${query}`;

    return randomGamesEnvelope(await request(baseUrl).get(path).set(caller.headers).expect(200), `GET ${path}`);
  };

  const idsOf = (envelope: { games: readonly { id: string }[] }) => envelope.games.map((game) => game.id);

  it('samples only games the caller could list, each once', async () => {
    const ids = idsOf(await sample('size=50'));

    expect(ids).toEqual(expect.arrayContaining([own.id, publicGame.id]));
    expect(ids).not.toContain(strangers.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns size games when there are more, and 10 when no size is named', async () => {
    const owner = await actors.user();
    await Promise.all(Array.from({ length: 12 }, (_, n) => addGame(`Public game ${n}`, owner.user.id, Reach.Public)));

    const three = idsOf(await sample('size=3'));
    expect(three).toHaveLength(3);
    expect(new Set(three).size).toBe(3);

    const unsized = idsOf(await sample());
    expect(unsized).toHaveLength(10);
    expect(new Set(unsized).size).toBe(10);
  });

  // The household preview's shape, so a game looks the same wherever it is sampled.
  it('shows each game as the game summary', async () => {
    const { games } = await sample('size=50');

    expect(games.length).toBeGreaterThan(0);
    for (const game of games) {
      expect(Object.keys(game).sort()).toEqual(['description', 'id', 'thumbnail', 'title']);
    }
  });

  // #961: a size outside 1–50 is refused with the size's own message, never
  // clamped or read as the default.
  it.each(['size=0', 'size=51', 'size=2.5', 'size=', 'size=abc', 'size=5&size=6'])('refuses %s', async (query) => {
    const response = await request(baseUrl).get(`${RANDOM_PATH}?${query}`).set(caller.headers).expect(400);

    expect(messageOf(response)).toEqual(expect.arrayContaining([expect.stringMatching(/^size /)]));
  });

  // Declared below `:id`, the route would answer `{ game }` for an id of
  // `random`, or 404. The `{ games }` envelope shows the sample answered.
  it('is not shadowed by GET /games/:id', async () => {
    const response = await request(baseUrl).get(RANDOM_PATH).set(caller.headers).expect(200);

    expect(response.body).not.toHaveProperty('game');
    expect(response.body).toHaveProperty('games');
  });
});
