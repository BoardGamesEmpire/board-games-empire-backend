import { Reach } from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * `GET /games/search/expansions` (#1067): a base game's expansions at its
 * DataGateways, named by a DataGateway and the game's external ID there, or
 * by the game's ID on this server.
 *
 * This suite runs no coordinator, so every case here is answered before one
 * would be asked: the refusals, and a game with no DataGateway link.
 */
describe('game search expansions', () => {
  const baseUrl = requireBaseUrl(process.env);
  const EXPANSIONS_PATH = '/api/games/search/expansions';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const expansions = (actor: AuthenticatedActor, query: Record<string, string>) =>
    request(baseUrl).get(EXPANSIONS_PATH).query(query).set(actor.headers);

  const arrangeGame = (createdById: string, reach: Reach) =>
    db.client.game.create({
      data: { title: `e2e expansions ${randomUUID().slice(0, 8)}`, reach, createdById },
      select: { id: true },
    });

  // Asking the DataGateways sends a request upstream on the server's
  // credentials, which an anonymous user may not do, whichever way the base
  // game is named (#1076).
  it('refuses an anonymous user either form', async () => {
    const anonymousUser = await actors.anonymous();
    const creator = await actors.user();
    const publicGame = await arrangeGame(creator.user.id, Reach.Public);

    await expansions(anonymousUser, { gatewayId: 'bgg', externalId: '13' }).expect(403);
    await expansions(anonymousUser, { gameId: publicGame.id }).expect(403);
  });

  // As `GET /games/:id` answers them, so an actor never learns the
  // DataGateway links of a game they can't open.
  it('answers 404 for an unknown game id and 403 for another user’s Private game', async () => {
    const creator = await actors.user();
    const other = await actors.user();
    const privateGame = await arrangeGame(creator.user.id, Reach.Private);

    await expansions(other, { gameId: `e2e-missing-${randomUUID()}` }).expect(404);
    await expansions(other, { gameId: privateGame.id }).expect(403);
  });

  it('answers an empty result for a readable game with no DataGateway link', async () => {
    const creator = await actors.user();
    const game = await arrangeGame(creator.user.id, Reach.Private);

    const response = await expansions(creator, { gameId: game.id }).expect(200);

    expect(response.body).toEqual({ correlationId: expect.any(String), resultsBySource: {} });
  });

  it('answers 400 when both forms or neither are given, and when the external ID passes 128 characters', async () => {
    const creator = await actors.user();
    const game = await arrangeGame(creator.user.id, Reach.Private);

    await expansions(creator, { gatewayId: 'bgg', externalId: '13', gameId: game.id }).expect(400);
    await expansions(creator, {}).expect(400);
    await expansions(creator, { gatewayId: 'bgg' }).expect(400);
    await expansions(creator, { gatewayId: 'bgg', externalId: '1'.repeat(129) }).expect(400);
  });
});
