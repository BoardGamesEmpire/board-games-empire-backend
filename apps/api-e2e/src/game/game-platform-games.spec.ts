import { PlatformType, Reach, ResourceType } from '@bge/database';
import { befriend, createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { mintApiKey, type Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { gameEnvelope, gamePlatformGames } from './game-wire';

/**
 * The platform games `GET /games/:id` sends (#791), against real rows. They are
 * what lets a client add a game on the server to a collection.
 *
 * `read:platform_game` reaches every platform game for a User, so being allowed
 * to read the game is what protects a private game's platform games, and the
 * permission on the platform game itself narrows only an API key. A reader's
 * rows therefore follow the game, and a key's follow its key scopes.
 *
 * Every denial below is paired with a control on the same row, so it cannot
 * pass because the rows were unreadable to everyone or were never there.
 */
describe('platform games on GET /games/:id (#791)', () => {
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

  const readGame = (caller: Caller, id: string) => request(baseUrl).get(`${GAMES_PATH}/${id}`).set(caller.headers);

  const platformGamesFor = async (caller: Caller, gameId: string, who: string) =>
    gamePlatformGames(await readGame(caller, gameId).expect(200), `GET /api/games/:id as ${who}`);

  const arrangeGame = (createdById: string, reach: Reach) =>
    db.client.game.create({
      data: { title: `e2e game ${randomUUID().slice(0, 8)}`, reach, createdById },
      select: { id: true },
    });

  const arrangePlatform = (name: string) => {
    const token = randomUUID().slice(0, 8);

    return db.client.platform.create({
      data: { name: `${name} ${token}`, slug: `${name.toLowerCase()}-${token}`, platformType: PlatformType.Other },
      select: { id: true, name: true },
    });
  };

  const arrangePlatformGame = async (gameId: string, platformName = 'Alpha') => {
    const platform = await arrangePlatform(platformName);

    return db.client.platformGame.create({ data: { gameId, platformId: platform.id }, select: { id: true } });
  };

  const arrangeGameWithPlatformGame = async (creator: AuthenticatedActor, reach: Reach) => {
    const game = await arrangeGame(creator.user.id, reach);
    const platformGame = await arrangePlatformGame(game.id);

    return { game, platformGame };
  };

  it('sends a reader the rows in platform name order, with only the named columns', async () => {
    const creator = await actors.user();
    const game = await arrangeGame(creator.user.id, Reach.Public);
    // Created in the opposite order to the one expected, so a read in creation
    // order fails. The two columns a client has no use for are set on the row
    // created second, so either one appearing fails the whole-row comparison.
    const beta = await arrangePlatform('Beta');
    const alpha = await arrangePlatform('Alpha');
    const betaRow = await db.client.platformGame.create({
      data: { gameId: game.id, platformId: beta.id },
      select: { id: true },
    });
    const alphaRow = await db.client.platformGame.create({
      data: { gameId: game.id, platformId: alpha.id, enrichmentSource: 'e2e', frozenAt: new Date() },
      select: { id: true },
    });

    const row = (id: string, platform: { id: string; name: string }) => ({
      id,
      gameId: game.id,
      image: null,
      thumbnail: null,
      minPlayers: null,
      maxPlayers: null,
      minPlayTime: null,
      maxPlayTime: null,
      supportsSolo: false,
      supportsLocal: false,
      supportsOnline: false,
      hasAsyncPlay: false,
      hasRealtime: false,
      hasTutorial: false,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      platform: { id: platform.id, name: platform.name, abbreviation: null, platformType: PlatformType.Other },
    });

    expect(await platformGamesFor(creator, game.id, 'the creator')).toEqual([
      row(alphaRow.id, alpha),
      row(betaRow.id, beta),
    ]);
  });

  it('answers a stranger 403 on a private game, and names no platform game', async () => {
    const creator = await actors.user();
    const stranger = await actors.user();
    const { game, platformGame } = await arrangeGameWithPlatformGame(creator, Reach.Private);

    // The control: the creator reads the same game and gets the row.
    const rows = await platformGamesFor(creator, game.id, 'the creator');
    expect(rows.map((row) => row.id)).toEqual([platformGame.id]);

    const refused = await readGame(stranger, game.id).expect(403);
    expect(JSON.stringify(refused.body)).not.toContain(platformGame.id);
  });

  // The rows follow the game: a reader it reaches only through its reach gets
  // them, with nothing of their own on the platform game.
  it('sends them to a friend the game reaches', async () => {
    const creator = await actors.user();
    const friend = await actors.user();
    const stranger = await actors.user();
    await befriend(db.client, friend, creator);
    const { game, platformGame } = await arrangeGameWithPlatformGame(creator, Reach.Friends);

    const rows = await platformGamesFor(friend, game.id, 'a friend');
    expect(rows.map((row) => row.id)).toEqual([platformGame.id]);

    // The control: the friendship is what opened it.
    await readGame(stranger, game.id).expect(403);
  });

  it('sends them to an admin reading a stranger’s private game', async () => {
    const creator = await actors.user();
    const admin = await actors.admin();
    const stranger = await actors.user();
    const { game, platformGame } = await arrangeGameWithPlatformGame(creator, Reach.Private);

    const rows = await platformGamesFor(admin, game.id, 'an admin');
    expect(rows.map((row) => row.id)).toEqual([platformGame.id]);

    // The control: the staff grant is what opened it.
    await readGame(stranger, game.id).expect(403);
  });

  // A game made through `POST /games` gets no platform (#492). The parser fails
  // on an absent list, so this holds only if the list is present and empty.
  it('sends an empty list for a game with no platform (#492)', async () => {
    const creator = await actors.user();
    const created = await request(baseUrl)
      .post(GAMES_PATH)
      .set(creator.headers)
      .send({ title: `e2e game ${randomUUID().slice(0, 8)}` })
      .expect(201);
    const { game } = gameEnvelope(created, 'POST /api/games');

    expect(await platformGamesFor(creator, game.id, 'the creator')).toEqual([]);
  });

  // A filter inside the game's `include` would hand this key every row, because
  // a deny-all condition is dropped there.
  it('sends a key with no read:platform_game an empty list', async () => {
    const keyOwner = await actors.user();
    const { game, platformGame } = await arrangeGameWithPlatformGame(keyOwner, Reach.Public);
    const gameOnly = await mintApiKey(baseUrl, db.client, keyOwner, {
      slugs: ['read:game'],
      resourceType: ResourceType.Game,
    });
    const both = await mintApiKey(baseUrl, db.client, keyOwner, [
      { slugs: ['read:game'], resourceType: ResourceType.Game },
      { slugs: ['read:platform_game'], resourceType: ResourceType.PlatformGame },
    ]);

    expect(await platformGamesFor(gameOnly, game.id, 'a key holding read:game alone')).toEqual([]);

    // The control: the same key owner's key holding both gets the row, so the
    // empty list above comes from the missing key scope.
    const rows = await platformGamesFor(both, game.id, 'a key holding both');
    expect(rows.map((row) => row.id)).toEqual([platformGame.id]);
  });

  it('sends a key pinned to one platform game that row alone', async () => {
    const keyOwner = await actors.user();
    const game = await arrangeGame(keyOwner.user.id, Reach.Public);
    const first = await arrangePlatformGame(game.id, 'Alpha');
    const second = await arrangePlatformGame(game.id, 'Beta');
    const pinned = await mintApiKey(baseUrl, db.client, keyOwner, [
      { slugs: ['read:game'], resourceType: ResourceType.Game },
      { slugs: ['read:platform_game'], resourceType: ResourceType.PlatformGame, resourceId: first.id },
    ]);

    const rows = await platformGamesFor(pinned, game.id, 'a pinned key');
    expect(rows.map((row) => row.id)).toEqual([first.id]);

    // The control: its key owner reads both, so the pin is what left the second out.
    const ownRows = await platformGamesFor(keyOwner, game.id, 'the key owner');
    expect(ownRows.map((row) => row.id)).toEqual([first.id, second.id]);
  });
});
