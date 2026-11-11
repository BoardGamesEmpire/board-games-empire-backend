import { ContentType, EventParticipationStatus, GameMedium, PlatformType, Reach, ResourceType } from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { arrangeCollectionEntry } from '../game-collection/game-collection-fixtures';
import { mintApiKey, type Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { arrangeOfferedGame, platformOfType, type OfferedGameFacts } from './event-fixtures';
import { attendeeGamesPath, attendeesPath, createEventClient, EVENTS_PATH } from './event-request';
import {
  attendeeEnvelope,
  listAttendeeGamesEnvelope,
  listAttendeesEnvelope,
  listOfferedGamesEnvelope,
  offeredGameEnvelope,
  type ListOfferedGamesEnvelope,
  type OfferedGameWire,
} from './event-wire';

/**
 * Every game an event's attendees offer, in one paged, filterable read, over
 * the real routes (#1187), and the one offered-game shape the reads and the
 * add serve (#1185).
 *
 * The ceilings are only enforced by the real CASL extension, in a top-level
 * `where` (#559), so the reads a key can't make are proven here, not in the
 * unit specs.
 */
describe('GET /api/events/:eventId/offered-games (#1187)', () => {
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

  const { createdEventId, listAttendees, listOfferedGames } = createEventClient(baseUrl);

  const offered = async (
    caller: Caller,
    eventId: string,
    query: Record<string, string | number | boolean> = {},
  ): Promise<ListOfferedGamesEnvelope> =>
    listOfferedGamesEnvelope(
      await listOfferedGames(caller, eventId, query).expect(200),
      `GET /api/events/:eventId/offered-games ${JSON.stringify(query)}`,
    );

  const titlesOf = (games: readonly OfferedGameWire[]) => games.map((row) => row.collection.platformGame.game.title);

  /** The titles listed for `query`, every row on one page. */
  const listedTitles = async (caller: Caller, eventId: string, query: Record<string, string | number | boolean>) =>
    titlesOf((await offered(caller, eventId, { limit: 100, ...query })).offeredGames);

  const attendeeIdOf = async (eventId: string, userId: string) =>
    (
      await db.client.eventAttendee.findUniqueOrThrow({
        where: { eventId_userId: { eventId, userId } },
        select: { id: true },
      })
    ).id;

  /** An event hosted by a fresh user, with fresh users invited to it as its other attendees. */
  const arrangeEvent = async (invited = 1) => {
    const host = await actors.user();
    const others: AuthenticatedActor[] = [];
    for (let index = 0; index < invited; index++) {
      others.push(await actors.user());
    }

    const eventId = await createdEventId(host, { inviteUserIds: others.map(({ user }) => user.id) });

    return { host, others, eventId, hostAttendeeId: await attendeeIdOf(eventId, host.user.id) };
  };

  const offer = (eventId: string, owner: AuthenticatedActor, facts: OfferedGameFacts = {}) =>
    arrangeOfferedGame(db.client, { eventId, ownerId: owner.user.id, ...facts });

  it('pages in title order with a total, and a page past the end is empty', async () => {
    const { host, others, eventId } = await arrangeEvent();
    await offer(eventId, host, { title: 'C' });
    await offer(eventId, others[0], { title: 'A' });
    await offer(eventId, host, { title: 'B' });

    const pages: ListOfferedGamesEnvelope[] = [];
    for (const page of [1, 2, 3, 4]) {
      pages.push(await offered(host, eventId, { page, limit: 1 }));
    }

    expect(pages.map(({ total }) => total)).toEqual([3, 3, 3, 3]);
    expect(pages.map(({ offeredGames }) => titlesOf(offeredGames))).toEqual([['A'], ['B'], ['C'], []]);
  });

  // A row is one offered entry, not one game.
  it('gives two rows when two attendees offer the same game', async () => {
    const { host, others, eventId, hostAttendeeId } = await arrangeEvent();
    const { platformGameId, gameId } = await offer(eventId, host, { title: 'Shared' });
    const otherAttendeeId = await attendeeIdOf(eventId, others[0].user.id);
    const theirs = await db.client.gameCollection.create({
      data: { userId: others[0].user.id, platformGameId, medium: GameMedium.Physical },
      select: { id: true },
    });
    await db.client.eventAttendeeGameList.create({ data: { attendeeId: otherAttendeeId, collectionId: theirs.id } });

    const { offeredGames, total } = await offered(host, eventId);

    expect(total).toBe(2);
    expect(offeredGames.map((row) => row.collection.platformGame.game.id)).toEqual([gameId, gameId]);
    expect(offeredGames.map((row) => row.attendeeId).sort()).toEqual([hostAttendeeId, otherAttendeeId].sort());
  });

  it('leaves out a game taken back and an attendee removed, from rows and total', async () => {
    const { host, others, eventId, hostAttendeeId } = await arrangeEvent(2);
    const [stays, leaves] = others;
    const takenBack = await offer(eventId, host, { title: 'Taken back' });
    await offer(eventId, stays, { title: 'Kept' });
    await offer(eventId, leaves, { title: 'Of the removed attendee' });

    await request(baseUrl)
      .delete(`${attendeeGamesPath(eventId, hostAttendeeId)}/${takenBack.entryId}`)
      .set(host.headers)
      .expect(200);
    await request(baseUrl)
      .delete(`${attendeesPath(eventId)}/${await attendeeIdOf(eventId, leaves.user.id)}`)
      .set(host.headers)
      .expect(200);

    const { offeredGames, total } = await offered(host, eventId);

    expect(titlesOf(offeredGames)).toEqual(['Kept']);
    expect(total).toBe(1);
  });

  it('filters each list both ways', async () => {
    const { host, others, eventId, hostAttendeeId } = await arrangeEvent();
    const [other] = others;
    const otherAttendeeId = await attendeeIdOf(eventId, other.user.id);
    await offer(eventId, host, { title: 'H1' });
    await offer(eventId, host, {
      title: 'H2',
      medium: GameMedium.Digital,
      platformType: PlatformType.PC,
      contentType: ContentType.Expansion,
    });
    await offer(eventId, other, { title: 'I1', contentType: ContentType.Expansion });
    // G is on PC too, but the copy offered is on the tabletop: only that one counts.
    const onBoth = await offer(eventId, other, { title: 'G' });
    await db.client.platformGame.create({
      data: { gameId: onBoth.gameId, platformId: await platformOfType(db.client, PlatformType.PC) },
    });

    // "Everyone's but mine."
    expect(await listedTitles(host, eventId, { excludeAttendeeIds: hostAttendeeId })).toEqual(['G', 'I1']);
    expect(
      await listedTitles(host, eventId, {
        attendeeIds: `${hostAttendeeId},${otherAttendeeId}`,
        excludeAttendeeIds: otherAttendeeId,
      }),
    ).toEqual(['H1', 'H2']);
    expect(await listedTitles(host, eventId, { mediums: GameMedium.Digital })).toEqual(['H2']);
    expect(await listedTitles(host, eventId, { excludeMediums: GameMedium.Digital })).toEqual(['G', 'H1', 'I1']);
    expect(await listedTitles(host, eventId, { contentTypes: ContentType.Expansion })).toEqual(['H2', 'I1']);
    expect(await listedTitles(host, eventId, { excludeContentTypes: ContentType.Expansion })).toEqual(['G', 'H1']);
    expect(await listedTitles(host, eventId, { platformTypes: PlatformType.PC })).toEqual(['H2']);
    expect(await listedTitles(host, eventId, { excludePlatformTypes: PlatformType.PC })).toEqual(['G', 'H1', 'I1']);

    await listOfferedGames(host, eventId, { attendeeIds: '' }).expect(400);
    await listOfferedGames(host, eventId, { platformTypes: 'Boardgame' }).expect(400);
  });

  // A host can offer a game for an attendee added by name (#1210), whose row
  // has no user.
  it("serves a guest attendee's offer with a null user and their guest name", async () => {
    const { host, eventId } = await arrangeEvent(0);
    const guestId = attendeeEnvelope(
      await request(baseUrl)
        .post(attendeesPath(eventId))
        .set(host.headers)
        .send({ guestName: 'Sam', guestEmail: `e2e-guest-${randomUUID().slice(0, 8)}@example.com` })
        .expect(201),
      'POST /api/events/:eventId/attendees as the host',
    ).id;
    await arrangeOfferedGame(db.client, { eventId, ownerId: host.user.id, attendeeId: guestId, title: "Sam's game" });

    const { offeredGames } = await offered(host, eventId);

    expect(offeredGames).toHaveLength(1);
    expect(offeredGames[0].attendeeId).toBe(guestId);
    expect(offeredGames[0].attendee).toEqual({
      id: guestId,
      status: EventParticipationStatus.Invited,
      guestName: 'Sam',
      user: null,
    });
  });

  it('filters players, play time and year, with include-unknown', async () => {
    const { host, eventId } = await arrangeEvent(0);
    await offer(eventId, host, {
      title: 'Range P',
      minPlayers: 2,
      maxPlayers: 4,
      minPlayTime: 30,
      maxPlayTime: 60,
      publishYear: 2015,
    });
    await offer(eventId, host, {
      title: 'Range Q',
      minPlayers: 5,
      maxPlayers: 8,
      minPlayTime: 120,
      maxPlayTime: 120,
      publishYear: 2021,
    });
    await offer(eventId, host, { title: 'Range U' });

    const players = { playerCountMin: 3, playerCountMax: 4 };
    expect(await listedTitles(host, eventId, players)).toEqual(['Range P']);
    expect(await listedTitles(host, eventId, { ...players, playerCountIncludeUnknown: true })).toEqual([
      'Range P',
      'Range U',
    ]);
    expect(await listedTitles(host, eventId, { playTimeMax: 60 })).toEqual(['Range P']);
    expect(await listedTitles(host, eventId, { playTimeMax: 60, playTimeIncludeUnknown: true })).toEqual([
      'Range P',
      'Range U',
    ]);
    expect(await listedTitles(host, eventId, { publishYearMin: 2020 })).toEqual(['Range Q']);
    // "Not 2020 or later" is the other bound.
    expect(await listedTitles(host, eventId, { publishYearMax: 2019, publishYearIncludeUnknown: true })).toEqual([
      'Range P',
      'Range U',
    ]);

    await listOfferedGames(host, eventId, { playerCountMin: 5, playerCountMax: 2 }).expect(400);
  });

  it('searches title and subtitle, a % matched literally', async () => {
    const { host, eventId } = await arrangeEvent(0);
    await offer(eventId, host, { title: '100% Orange Juice' });
    await offer(eventId, host, { title: 'Top 100 Games' });
    await offer(eventId, host, { title: 'Catan', subtitle: 'Seafarers' });

    expect(await listedTitles(host, eventId, { q: '100%' })).toEqual(['100% Orange Juice']);
    expect(await listedTitles(host, eventId, { q: 'SEAFARERS' })).toEqual(['Catan']);
    expect(await listedTitles(host, eventId, { q: 'catan seafarers' })).toEqual(['Catan']);
    expect(await listedTitles(host, eventId, { q: 'catan juice' })).toEqual([]);
    // Only spaces narrow nothing.
    expect(await listedTitles(host, eventId, { q: '   ' })).toEqual(['100% Orange Juice', 'Catan', 'Top 100 Games']);
  });

  // The owner's rating and comment are theirs, not the event's. Every site
  // serves the one shape, so a column added to the collection row reaches
  // none of them.
  it("serves exactly the offered-game keys, and never the owner's rating or comment (#1185)", async () => {
    const { host, eventId, hostAttendeeId } = await arrangeEvent(0);
    const note = `private note ${randomUUID().slice(0, 8)}`;
    const listed = await offer(eventId, host, { title: 'Listed' });
    const added = await arrangeCollectionEntry(db.client, host.user.id, Reach.Private);
    await db.client.gameCollection.updateMany({
      where: { id: { in: [listed.collectionId, added] } },
      data: { rating: 9, comment: note, playCount: 12, quantity: 3 },
    });

    const entryKeys = ['attendeeId', 'collection', 'createdAt', 'id', 'supplies'];
    const expectOfferedShape = (row: OfferedGameWire, site: string, keys = entryKeys) => {
      expect({ site, keys: Object.keys(row).sort() }).toEqual({ site, keys });
      expect({ site, keys: Object.keys(row.collection).sort() }).toEqual({
        site,
        keys: ['id', 'medium', 'platformGame'],
      });
      expect(JSON.stringify(row)).not.toContain(note);
    };

    const [route] = (await offered(host, eventId)).offeredGames;
    expectOfferedShape(route, 'offered-games', [...entryKeys, 'attendee'].sort());

    const perAttendee = listAttendeeGamesEnvelope(
      await request(baseUrl).get(attendeeGamesPath(eventId, hostAttendeeId)).set(host.headers).expect(200),
      'GET /api/events/:eventId/attendees/:attendeeId/games as the host',
    );
    expectOfferedShape(perAttendee.games[0], 'per-attendee');

    const answer = offeredGameEnvelope(
      await request(baseUrl)
        .post(attendeeGamesPath(eventId, hostAttendeeId))
        .set(host.headers)
        .send({ collectionId: added })
        .expect(201),
      'POST /api/events/:eventId/attendees/:attendeeId/games as the host',
    );
    expectOfferedShape(answer, 'add');

    const { attendees } = listAttendeesEnvelope(
      await listAttendees(host, eventId).expect(200),
      'GET /api/events/:eventId/attendees as the host',
    );
    const embedded = (attendees[0] as unknown as { availableGames: OfferedGameWire[] }).availableGames;
    expect(embedded).toHaveLength(2);
    embedded.forEach((row) => expectOfferedShape(row, 'attendee list'));
  });

  // In the entry's select, the attendee's name and avatar, and the counts,
  // would reach a key that can read neither (#404, #559). A key's grant keeps
  // its action and type but not the permission's conditions (#266).
  it('serves a key with read on offered games alone no attendee and no counts', async () => {
    const { host, eventId, hostAttendeeId } = await arrangeEvent(0);
    await offer(eventId, host, { title: 'Read by a key' });
    const key = await mintApiKey(baseUrl, db.client, host, {
      slugs: ['read:attendee_game_list'],
      resourceType: ResourceType.EventAttendeeGameList,
    });

    // The control: the key's owner gets the attendee and the counts.
    const [own] = (await offered(host, eventId)).offeredGames;
    expect(own.attendee?.id).toBe(hostAttendeeId);
    expect(own.supplies).toEqual({ nominations: 0, lineup: 0 });

    const { offeredGames, total } = await offered(key, eventId);

    expect(total).toBe(1);
    expect(offeredGames[0].attendeeId).toBe(hostAttendeeId);
    expect(offeredGames[0].attendee).toBeNull();
    expect(offeredGames[0].supplies).toEqual({ nominations: null, lineup: null });
  });

  it('gives a reader without read on offered games a 403', async () => {
    const { host, eventId } = await arrangeEvent(0);
    await offer(eventId, host);
    const stranger = await actors.user();

    await listOfferedGames(stranger, eventId).expect(403);
  });

  // The route's check passes anyone who reads offered games in some event; the
  // ceiling, composed at the top level, is what keeps other events' games
  // from them. Removing it would pass every other test here.
  it("lists no games to an attendee of another event, by the read's ceiling", async () => {
    const { host, eventId } = await arrangeEvent(0);
    await offer(eventId, host, { title: 'Not theirs' });
    const otherHost = await actors.user();
    const otherEventId = await createdEventId(otherHost);
    await offer(otherEventId, otherHost, { title: 'Theirs' });

    // The control: they read their own event's games, and the host reads these.
    expect(titlesOf((await offered(otherHost, otherEventId)).offeredGames)).toEqual(['Theirs']);
    expect(titlesOf((await offered(host, eventId)).offeredGames)).toEqual(['Not theirs']);

    expect(await offered(otherHost, eventId)).toEqual({ offeredGames: [], total: 0 });
  });

  it("answers 404 for an event that doesn't exist, or was deleted", async () => {
    const { host, eventId } = await arrangeEvent(0);
    await offer(eventId, host);

    await listOfferedGames(host, `missing-${randomUUID()}`).expect(404);

    await request(baseUrl).delete(`${EVENTS_PATH}/${eventId}`).set(host.headers).expect(200);
    await listOfferedGames(host, eventId).expect(404);
  });

  it('pages the per-attendee route (#1001)', async () => {
    const { host, eventId, hostAttendeeId } = await arrangeEvent(0);
    await offer(eventId, host, { title: 'C' });
    await offer(eventId, host, { title: 'A' });
    await offer(eventId, host, { title: 'B' });

    const pages = [];
    for (const page of [1, 2, 3, 4]) {
      pages.push(
        listAttendeeGamesEnvelope(
          await request(baseUrl)
            .get(attendeeGamesPath(eventId, hostAttendeeId))
            .query({ page, limit: 1 })
            .set(host.headers)
            .expect(200),
          'GET /api/events/:eventId/attendees/:attendeeId/games as the host',
        ),
      );
    }

    expect(pages.map(({ total }) => total)).toEqual([3, 3, 3, 3]);
    expect(pages.map(({ games }) => titlesOf(games))).toEqual([['A'], ['B'], ['C'], []]);
  });

  // The embed was an include, so it reached anyone who could read attendees,
  // whatever their read on offered games: #404's sixth site.
  it("withholds the attendee list's games from a key with attendee read alone (#404)", async () => {
    const { host, eventId } = await arrangeEvent(0);
    const { entryId } = await offer(eventId, host);
    const key = await mintApiKey(baseUrl, db.client, host, {
      slugs: ['read:event_attendee'],
      resourceType: ResourceType.EventAttendee,
    });
    const embeddedIds = async (caller: Caller) =>
      listAttendeesEnvelope(
        await listAttendees(caller, eventId).expect(200),
        'GET /api/events/:eventId/attendees',
      ).attendees.map((attendee) =>
        (attendee as unknown as { availableGames: OfferedGameWire[] }).availableGames.map(({ id }) => id),
      );

    // The control: the key's owner sees the game on their row.
    expect(await embeddedIds(host)).toEqual([[entryId]]);

    expect(await embeddedIds(key)).toEqual([[]]);
  });
});
