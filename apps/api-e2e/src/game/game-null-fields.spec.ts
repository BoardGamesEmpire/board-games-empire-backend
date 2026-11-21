import { Reach } from '@bge/database';
import type { Actors, AuthenticatedActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';

/**
 * What a game's edit accepts for `null` (#1275).
 *
 * `UpdateGameDto` inherited `title` through `PartialType`, whose `IsOptional`
 * skips `null`, so a `null` title passed the pipe and answered 500 at the
 * non-nullable column. The nullable columns still clear with `null`.
 */
describe("a game's fields on update (#1275)", () => {
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

  const updateGame = (actor: AuthenticatedActor, id: string, body: Record<string, unknown>) =>
    request(baseUrl).patch(`${GAMES_PATH}/${id}`).set(actor.headers).send(body);

  /** A game its creator may edit, with a subtitle to clear. */
  const arrangeGame = (createdById: string) =>
    db.client.game.create({
      data: {
        title: `e2e game ${randomUUID().slice(0, 8)}`,
        subtitle: 'The Card Game',
        reach: Reach.Public,
        createdById,
      },
      select: { id: true },
    });

  const storedGame = (id: string) => db.client.game.findUniqueOrThrow({ where: { id } });

  it('PATCH /games/:id answers 400 to a null title and leaves the game as it was (#1275)', async () => {
    const creator = await actors.user();
    const game = await arrangeGame(creator.user.id);
    const before = await storedGame(game.id);

    expectErrorEnvelope(await updateGame(creator, game.id, { title: null }), { status: 400, code: null });

    expect(await storedGame(game.id)).toEqual(before);
  });

  // The control: the same caller may edit the game, and null clears a
  // nullable column.
  it('PATCH /games/:id clears subtitle with null (#1275)', async () => {
    const creator = await actors.user();
    const game = await arrangeGame(creator.user.id);

    await updateGame(creator, game.id, { subtitle: null }).expect(200);

    expect(await storedGame(game.id)).toMatchObject({ subtitle: null });
  });
});
