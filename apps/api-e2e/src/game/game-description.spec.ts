import { Visibility } from '@bge/database';
import { createActors, type Actors } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { gameEnvelope } from './game-wire';

/**
 * A description someone types in is Markdown, stored the way an imported one
 * is: raw HTML stripped, and a link that isn't http, https or mailto reduced
 * to its text (#714). Run against the api bundle, which loads the Markdown
 * packages, all pure ESM, with require().
 */
describe('game descriptions', () => {
  const baseUrl = requireBaseUrl(process.env);
  const GAMES_PATH = '/api/games';

  const unsafe = 'Trade <b>wisely</b>.<img src=x onerror=alert(1)> Read [the rules](javascript:alert(1)).';
  const sanitized = 'Trade wisely. Read the rules.';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const storedDescription = async (id: string) =>
    (await db.client.game.findUniqueOrThrow({ where: { id }, select: { description: true } })).description;

  it('stores and serves a description sent on create as sanitized Markdown', async () => {
    const creator = await actors.user();

    const created = await request(baseUrl)
      .post(GAMES_PATH)
      .set(creator.headers)
      .send({ title: 'Described prototype', description: unsafe })
      .expect(201);
    const { game } = gameEnvelope(created, 'POST /api/games');

    expect(game.description).toBe(sanitized);
    expect(await storedDescription(game.id)).toBe(sanitized);
  });

  it('sanitizes a description sent on update, and keeps safe Markdown exactly as sent', async () => {
    const creator = await actors.user();
    const { id } = await db.client.game.create({
      data: { title: 'Edited prototype', visibility: Visibility.Public, createdById: creator.user.id },
      select: { id: true },
    });
    const update = (description: string) =>
      request(baseUrl).patch(`${GAMES_PATH}/${id}`).set(creator.headers).send({ description }).expect(200);

    await update(unsafe);
    expect(await storedDescription(id)).toBe(sanitized);

    const safe = '__Trade__ wisely, and see [the rules](https://example.com/rules).';
    await update(safe);
    expect(await storedDescription(id)).toBe(safe);
  });

  it('refuses a new description over 20,000 characters, but takes a longer one the game has back unchanged', async () => {
    const creator = await actors.user();
    const long = 'a'.repeat(20_001);

    await request(baseUrl)
      .post(GAMES_PATH)
      .set(creator.headers)
      .send({ title: 'Long prototype', description: long })
      .expect(400);

    // An import can store a longer one, and a client may send it back with an edit to another field.
    const stored = String.raw`\*Imported\* ` + long;
    const { id } = await db.client.game.create({
      data: {
        title: 'Imported prototype',
        description: stored,
        visibility: Visibility.Public,
        createdById: creator.user.id,
      },
      select: { id: true },
    });

    await request(baseUrl)
      .patch(`${GAMES_PATH}/${id}`)
      .set(creator.headers)
      .send({ title: 'Renamed prototype', description: stored })
      .expect(200);
    expect(await storedDescription(id)).toBe(stored);
  });
});
