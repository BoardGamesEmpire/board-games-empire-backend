import { ContentType, GameMedium, PlatformType, Reach, SystemRole } from '@bge/database';
import type { Actors, AuthenticatedActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { arrangeCollectionEntry } from '../game-collection/game-collection-fixtures';
import { requireBaseUrl } from '../support/e2e-env';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { arrangeOfferedGame, platformOfType } from './event-fixtures';
import { attendeesPath, createEventClient, offerGamesPath } from './event-request';
import type { OfferResultWire } from './event-wire';
import { attendeeEnvelope, listOfferedGamesEnvelope, offerResultsEnvelope } from './event-wire';

/**
 * Offering several games at once, each a game with a choice of its
 * expansions, over the real routes (#1188). Each entry is judged as the single
 * add judges one, and a bad one loses nothing else.
 */
describe('POST /api/events/:eventId/attendees/:attendeeId/games/batch (#1188)', () => {
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

  const { createdEventId, listOfferedGames } = createEventClient(baseUrl);

  /** An event hosted by a fresh user, and the host's attendee id. */
  const arrangeEvent = async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);
    const { id: hostAttendeeId } = await db.client.eventAttendee.findUniqueOrThrow({
      where: { eventId_userId: { eventId, userId: host.user.id } },
      select: { id: true },
    });

    return { host, eventId, hostAttendeeId };
  };

  /** A collection entry of `owner`'s, on a fresh game with `title` and `contentType`. */
  const owned = async (
    owner: AuthenticatedActor,
    title: string,
    contentType: ContentType = ContentType.BaseGame,
    platformType: PlatformType = PlatformType.Tabletop,
  ) => {
    const game = await db.client.game.create({ data: { title, contentType }, select: { id: true } });
    const platformGame = await db.client.platformGame.create({
      data: { gameId: game.id, platformId: await platformOfType(db.client, platformType) },
      select: { id: true },
    });
    const collection = await db.client.gameCollection.create({
      data: { userId: owner.user.id, platformGameId: platformGame.id, medium: GameMedium.Physical },
      select: { id: true },
    });

    return { collectionId: collection.id, gameId: game.id };
  };

  const offerGames = (actor: AuthenticatedActor, eventId: string, attendeeId: string, items: unknown[]) =>
    request(baseUrl).post(offerGamesPath(eventId, attendeeId)).set(actor.headers).send({ items });

  const offered = async (actor: AuthenticatedActor, eventId: string, attendeeId: string, items: unknown[]) =>
    offerResultsEnvelope(
      await offerGames(actor, eventId, attendeeId, items).expect(200),
      'POST /api/events/:eventId/attendees/:attendeeId/games/batch',
    );

  const outcomes = (results: readonly OfferResultWire[]) =>
    results.map((result) => [result.collectionId, result.outcome === 'refused' ? result.reason : result.outcome]);

  it('offers forty games in one request', async () => {
    const { host, eventId, hostAttendeeId } = await arrangeEvent();
    const collectionIds: string[] = [];
    for (let index = 0; index < 40; index++) {
      collectionIds.push(await arrangeCollectionEntry(db.client, host.user.id, Reach.Private));
    }

    const results = await offered(
      host,
      eventId,
      hostAttendeeId,
      collectionIds.map((collectionId) => ({ collectionId })),
    );

    expect(outcomes(results)).toEqual(collectionIds.map((collectionId) => [collectionId, 'added']));
    // Each answer's entry is the offered-game shape: none of the owner's row (#1185).
    for (const result of results) {
      const entry = result.outcome === 'refused' ? undefined : result.entry;
      expect(Object.keys(entry ?? {}).sort()).toEqual([
        'attendeeId',
        'collection',
        'createdAt',
        'id',
        'onWishlist',
        'supplies',
      ]);
      expect(Object.keys(entry?.collection ?? {}).sort()).toEqual(['id', 'medium', 'platformGame']);
    }

    const listed = listOfferedGamesEnvelope(
      await listOfferedGames(host, eventId, { limit: 100 }).expect(200),
      'GET /api/events/:eventId/offered-games as the host',
    );
    expect(listed.total).toBe(40);
  });

  it('offers a game with two of its expansions, and their rows name the base game', async () => {
    const { host, eventId, hostAttendeeId } = await arrangeEvent();
    const base = await owned(host, 'Catan');
    const seafarers = await owned(host, 'Catan: Seafarers', ContentType.Expansion);
    const cities = await owned(host, 'Catan: Cities & Knights', ContentType.Expansion);
    await db.client.gameExpansion.createMany({
      data: [
        { baseGameId: base.gameId, expansionGameId: seafarers.gameId },
        { baseGameId: base.gameId, expansionGameId: cities.gameId },
      ],
    });

    const results = await offered(host, eventId, hostAttendeeId, [
      { collectionId: base.collectionId, expansionCollectionIds: [seafarers.collectionId, cities.collectionId] },
    ]);

    expect(outcomes(results)).toEqual([
      [base.collectionId, 'added'],
      [seafarers.collectionId, 'added'],
      [cities.collectionId, 'added'],
    ]);

    const { offeredGames } = listOfferedGamesEnvelope(
      await listOfferedGames(host, eventId).expect(200),
      'GET /api/events/:eventId/offered-games as the host',
    );
    const baseGamesOf = Object.fromEntries(
      offeredGames.map((row) => [
        row.collection.id,
        row.collection.platformGame.game.baseGames.map(({ gameId }) => gameId),
      ]),
    );
    expect(baseGamesOf).toEqual({
      [base.collectionId]: [],
      [seafarers.collectionId]: [base.gameId],
      [cities.collectionId]: [base.gameId],
    });
  });

  it('refuses a linked expansion whose entry is on another platform from its game as differentPlatform (#1391)', async () => {
    const { host, eventId, hostAttendeeId } = await arrangeEvent();
    const base = await owned(host, 'Civilization (tabletop)');
    const onPc = await owned(host, 'Civilization: Gods & Kings (PC)', ContentType.Expansion, PlatformType.PC);
    await db.client.gameExpansion.create({ data: { baseGameId: base.gameId, expansionGameId: onPc.gameId } });

    const results = await offered(host, eventId, hostAttendeeId, [
      { collectionId: base.collectionId, expansionCollectionIds: [onPc.collectionId] },
    ]);

    expect(results[0]).toEqual(expect.objectContaining({ collectionId: base.collectionId, outcome: 'added' }));
    expect(results[1]).toEqual({
      collectionId: onPc.collectionId,
      outcome: 'refused',
      reason: 'differentPlatform',
      message: 'This expansion is on a different platform from the game it was offered with.',
    });
  });

  it("reports an already-offered id as alreadyOffered and a stranger's entry as notInAttendeesCollection, adding the rest", async () => {
    const { host, eventId, hostAttendeeId } = await arrangeEvent();
    const stranger = await actors.user();
    const already = await arrangeOfferedGame(db.client, { eventId, ownerId: host.user.id });
    const strangers = await arrangeCollectionEntry(db.client, stranger.user.id, Reach.Private);
    const fresh = await arrangeCollectionEntry(db.client, host.user.id, Reach.Private);

    const results = await offered(host, eventId, hostAttendeeId, [
      { collectionId: already.collectionId },
      { collectionId: strangers },
      { collectionId: fresh },
    ]);

    expect(outcomes(results)).toEqual([
      [already.collectionId, 'alreadyOffered'],
      [strangers, 'notInAttendeesCollection'],
      [fresh, 'added'],
    ]);
    expect(results[0]).toEqual(expect.objectContaining({ entry: expect.objectContaining({ id: already.entryId }) }));
    // The message is translated in the response, not left as a catalog key.
    expect(results[1]).toEqual(
      expect.objectContaining({ message: "Cannot add a game from another user's collection." }),
    );
  });

  it('refuses every id for an attendee added by name as attendeeHasNoCollection, and adds nothing (#1210)', async () => {
    const { host, eventId } = await arrangeEvent();
    const stranger = await actors.user();
    const nameOnlyAttendeeId = attendeeEnvelope(
      await request(baseUrl)
        .post(attendeesPath(eventId))
        .set(host.headers)
        .send({ guestName: 'Sam', guestEmail: `e2e-guest-${randomUUID().slice(0, 8)}@example.com` })
        .expect(201),
      'POST /api/events/:eventId/attendees as the host',
    ).id;
    const hosts = await arrangeCollectionEntry(db.client, host.user.id, Reach.Private);
    const strangers = await arrangeCollectionEntry(db.client, stranger.user.id, Reach.Private);

    const results = await offered(host, eventId, nameOnlyAttendeeId, [
      { collectionId: hosts },
      { collectionId: strangers },
    ]);

    expect(outcomes(results)).toEqual([
      [hosts, 'attendeeHasNoCollection'],
      [strangers, 'attendeeHasNoCollection'],
    ]);
    expect(await db.client.eventAttendeeGameList.count({ where: { attendeeId: nameOnlyAttendeeId } })).toBe(0);
  });

  it('refuses 101 ids, and a repeated id, with 400', async () => {
    const { host, eventId, hostAttendeeId } = await arrangeEvent();
    const collectionId = await arrangeCollectionEntry(db.client, host.user.id, Reach.Private);
    const ids = Array.from({ length: 101 }, (_, index) => `col-${index}`);

    // The control: the largest batch the cap allows passes validation.
    await offerGames(
      host,
      eventId,
      hostAttendeeId,
      ids.slice(0, 100).map((id) => ({ collectionId: id })),
    ).expect(200);

    await offerGames(
      host,
      eventId,
      hostAttendeeId,
      ids.map((id) => ({ collectionId: id })),
    ).expect(400);
    await offerGames(host, eventId, hostAttendeeId, [
      { collectionId: 'col-0', expansionCollectionIds: ids.slice(1, 100) },
      { collectionId: 'col-100' },
    ]).expect(400);
    await offerGames(host, eventId, hostAttendeeId, [
      { collectionId, expansionCollectionIds: ['col-x'] },
      { collectionId: 'col-x' },
    ]).expect(400);

    expect(await db.client.eventAttendeeGameList.count({ where: { collectionId } })).toBe(0);
  });

  it('refuses a spectator with 403', async () => {
    const { host, eventId } = await arrangeEvent();
    const spectator = await actors.user();
    const spectatorAttendeeId = attendeeEnvelope(
      await request(baseUrl)
        .post(attendeesPath(eventId))
        .set(host.headers)
        .send({ userId: spectator.user.id, role: SystemRole.EventSpectator })
        .expect(201),
      'POST /api/events/:eventId/attendees as the host',
    ).id;
    const collectionId = await arrangeCollectionEntry(db.client, spectator.user.id, Reach.Private);

    await offerGames(spectator, eventId, spectatorAttendeeId, [{ collectionId }]).expect(403);
    expect(await db.client.eventAttendeeGameList.count({ where: { collectionId } })).toBe(0);
  });
});
