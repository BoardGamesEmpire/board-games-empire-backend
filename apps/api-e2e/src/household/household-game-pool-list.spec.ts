import { GameMedium, Reach, SystemRole } from '@bge/database';
import type { Actors, HouseholdRoleName, SessionActor } from '@bge/testing-e2e';
import { befriend, createActors, createHouseholdWithMembers } from '@bge/testing-e2e';
import request from 'supertest';
import { arrangeCollectionEntry } from '../game-collection/game-collection-fixtures';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import { tabletopPlatform } from '../support/seeded-platforms';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { createEnvelope, gamePoolEnvelope, readEnvelope } from './household-wire';

/**
 * `GET /api/households/:id/games`: one household's game pool, a page at a
 * time, each row a game with the owners whose entries put it there (#367).
 *
 * An entry is in the game pool when its owner has collection sharing on in
 * this household and hasn't excluded it here, read under the GameCollection
 * ceiling, and its game under the Game ceiling. The game is the row and the
 * counted unit.
 *
 * Who may open it is the household's game pool reach: its members and guests
 * always, and, at `Friends`, anyone who can read the household, who then sees
 * only the entries they could already read. The game pool reach never reaches
 * further than the household's own reach.
 *
 * Each test creates its actors, then the rosters, friendships and rows,
 * before any authenticated request (#256 ordering rule).
 */
describe('household game pool list (#367)', () => {
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

  /** A household owned by `owner`, with each of `members` in the role given, a plain member by default. */
  const household = async (
    owner: SessionActor,
    members: readonly (SessionActor | { actor: SessionActor; role: HouseholdRoleName })[] = [],
  ) => {
    const fixture = await createHouseholdWithMembers(db.client, {
      owner,
      members: members.map((entry) => ('role' in entry ? entry : { actor: entry, role: SystemRole.HouseholdMember })),
    });

    const memberIdOf = (actor: SessionActor) => {
      const roster = [fixture.owner, ...fixture.members];
      const membership = roster.find((entry) => entry.member.userId === actor.user.id)?.member;
      if (membership === undefined) {
        throw new Error(`the fixture left ${actor.user.id} off the roster`);
      }

      return membership.id;
    };

    return { id: fixture.household.id, memberIdOf };
  };

  const gamesPath = (householdId: string, query = 'limit=100') => `/api/households/${householdId}/games?${query}`;

  const readGamePool = (actor: SessionActor, householdId: string, query?: string) =>
    request(baseUrl).get(gamesPath(householdId, query)).set(actor.headers);

  const gamePoolOf = async (actor: SessionActor, householdId: string, query?: string) =>
    gamePoolEnvelope(await readGamePool(actor, householdId, query).expect(200), 'GET /api/households/:id/games');

  const gamePoolIds = async (actor: SessionActor, householdId: string) =>
    (await gamePoolOf(actor, householdId)).games.map((game) => game.id).sort();

  const editHousehold = (actor: SessionActor, householdId: string, body: Record<string, unknown>) =>
    request(baseUrl).patch(`/api/households/${householdId}`).set(actor.headers).send(body);

  const exclude = (actor: SessionActor, householdId: string, collectionEntryId: string) =>
    request(baseUrl)
      .post(`/api/households/${householdId}/members/me/excluded-games`)
      .set(actor.headers)
      .send({ collectionEntryId });

  /** The game pool reach as the owner reads it on the household's detail. */
  const gamePoolReachOf = async (owner: SessionActor, householdId: string) =>
    readEnvelope(
      await request(baseUrl).get(`/api/households/${householdId}`).set(owner.headers).expect(200),
      'GET /api/households/:id',
    ).household.settings?.gamePoolReach;

  /** The game a collection entry holds. */
  const gameOf = async (entryId: string) =>
    (
      await db.client.gameCollection.findUniqueOrThrow({
        where: { id: entryId },
        select: { platformGame: { select: { gameId: true } } },
      })
    ).platformGame.gameId;

  /** Another collection entry for `ownerId` on the same platform game as `entryId`. */
  const secondCopy = async (entryId: string, ownerId: string, medium: GameMedium = GameMedium.Physical) => {
    const { platformGameId } = await db.client.gameCollection.findUniqueOrThrow({
      where: { id: entryId },
      select: { platformGameId: true },
    });

    return (
      await db.client.gameCollection.create({
        data: { userId: ownerId, platformGameId, medium },
        select: { id: true },
      })
    ).id;
  };

  const nameAs = (actor: SessionActor, displayName: string) =>
    db.client.userProfile.upsert({
      where: { userId: actor.user.id },
      create: { userId: actor.user.id, displayName },
      update: { displayName },
    });

  const sorted = (ids: readonly string[]) => [...ids].sort();

  describe('what it lists', () => {
    // Owners order by shown name, then memberId, then entry id, so Amy's
    // entry comes before both of Zed's though Zed's came first (#367).
    it('lists a game two members own as one row naming each entry, and counts it once (#367)', async () => {
      const [viewer, zed, amy] = [await actors.user(), await actors.user(), await actors.user()];
      const home = await household(viewer, [zed, amy]);
      await nameAs(zed, 'Zed');
      await nameAs(amy, 'Amy');
      const zedsEntry = await arrangeCollectionEntry(db.client, zed.user.id, Reach.Private);
      const zedsDigitalCopy = await secondCopy(zedsEntry, zed.user.id, GameMedium.Digital);
      const amysEntry = await secondCopy(zedsEntry, amy.user.id);
      const game = await db.client.game.findUniqueOrThrow({
        where: { id: await gameOf(zedsEntry) },
        select: { id: true, title: true, thumbnail: true, description: true },
      });
      const platform = await db.client.platform.findUniqueOrThrow({
        where: { id: (await tabletopPlatform(db.client)).id },
        select: { id: true, name: true },
      });

      const { games, pagination } = await gamePoolOf(viewer, home.id);

      expect(pagination.total).toBe(1);
      expect(games).toHaveLength(1);
      expect(games[0]).toMatchObject(game);
      expect(games[0].owners).toEqual([
        {
          memberId: home.memberIdOf(amy),
          collectionEntryId: amysEntry,
          platform,
          user: expect.objectContaining({ id: amy.user.id, profile: expect.objectContaining({ displayName: 'Amy' }) }),
        },
        ...sorted([zedsEntry, zedsDigitalCopy]).map((collectionEntryId) => ({
          memberId: home.memberIdOf(zed),
          collectionEntryId,
          platform,
          user: expect.objectContaining({ id: zed.user.id, profile: expect.objectContaining({ displayName: 'Zed' }) }),
        })),
      ]);
    });

    it('names only the other owner once one of two owners excludes the game (#367, #170)', async () => {
      const [viewer, m1, m2] = [await actors.user(), await actors.user(), await actors.user()];
      const home = await household(viewer, [m1, m2]);
      const m1sEntry = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);
      const m2sEntry = await secondCopy(m1sEntry, m2.user.id);

      const ownersOf = async () =>
        (await gamePoolOf(viewer, home.id)).games.map((row) => ({
          id: row.id,
          owners: row.owners.map((owner) => owner.collectionEntryId).sort(),
        }));

      // The control: both entries name an owner until one is excluded.
      expect(await ownersOf()).toEqual([{ id: await gameOf(m1sEntry), owners: sorted([m1sEntry, m2sEntry]) }]);

      await exclude(m1, home.id, m1sEntry).expect(201);

      expect(await ownersOf()).toEqual([{ id: await gameOf(m1sEntry), owners: [m2sEntry] }]);
    });

    // Title, then id, so games with the same title page the same way on
    // every read, and `total` counts games, not entries (#367).
    it('pages games by title, then id, with a total of games (#367)', async () => {
      const [viewer, m1] = [await actors.user(), await actors.user()];
      const home = await household(viewer, [m1]);
      const sameTitled = await Promise.all(
        [0, 1, 2].map(() => arrangeCollectionEntry(db.client, m1.user.id, Reach.Private)),
      );
      const earlierEntry = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);
      // A second entry of one game: one more entry, no more games.
      await secondCopy(earlierEntry, m1.user.id, GameMedium.Digital);
      const sameTitledGames = await Promise.all(sameTitled.map(gameOf));
      await db.client.game.updateMany({ where: { id: { in: sameTitledGames } }, data: { title: 'Same title' } });
      const earlier = await gameOf(earlierEntry);
      await db.client.game.update({ where: { id: earlier }, data: { title: 'An earlier title' } });
      // Ordered by the database, as the read orders them.
      const byId = await db.client.game.findMany({
        where: { id: { in: sameTitledGames } },
        orderBy: { id: 'asc' },
        select: { id: true },
      });

      const pages = [];
      for (const page of [1, 2, 3, 4, 5]) {
        pages.push(await gamePoolOf(viewer, home.id, `page=${page}&limit=1`));
      }

      expect(pages.map(({ games }) => games.map((game) => game.id))).toEqual([
        [earlier],
        ...byId.map(({ id }) => [id]),
        [],
      ]);
      expect(pages.map(({ pagination }) => [pagination.total, pagination.totalPages, pagination.hasMore])).toEqual([
        [4, 4, true],
        [4, 4, true],
        [4, 4, true],
        [4, 4, false],
        [4, 4, false],
      ]);
    });

    // While #492 is open no route lets a member collect a game they cannot
    // read, so the database seeds it.
    it("leaves out a game the caller can't open, though a member shares it (#367)", async () => {
      const [viewer, m1, stranger] = [await actors.user(), await actors.user(), await actors.user()];
      const home = await household(viewer, [m1]);
      const platform = await tabletopPlatform(db.client);
      const hidden = await db.client.game.create({
        data: { title: "A stranger's, Private", reach: Reach.Private, createdById: stranger.user.id },
        select: { id: true },
      });
      const platformGame = await db.client.platformGame.create({
        data: { gameId: hidden.id, platformId: platform.id },
        select: { id: true },
      });
      await db.client.gameCollection.create({
        data: { userId: m1.user.id, platformGameId: platformGame.id, medium: GameMedium.Physical },
      });
      // The control: m1's other entry is listed.
      const visible = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);

      const { games, pagination } = await gamePoolOf(viewer, home.id);

      expect(games.map((game) => game.id)).toEqual([await gameOf(visible)]);
      expect(pagination.total).toBe(1);
      await request(baseUrl).get(`/api/games/${hidden.id}`).set(viewer.headers).expect(403);
    });

    // By the exact rule this entry is in B's game pool. But the
    // GameCollection ceiling's household rule can't tie an excluded game to
    // the household it was excluded from, so an excluded game in any household
    // the caller shares with the owner hides it, and the list never serves more than the
    // collection read (#367). Pinned so a change to the approximation is seen.
    it('leaves out an entry excluded from one household the caller shares with its owner, though shared in another (#367)', async () => {
      const [viewer, m1] = [await actors.user(), await actors.user()];
      const a = await household(viewer, [m1]);
      const b = await household(viewer, [m1]);
      const entry = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);
      // The control: m1's other entry is still in B's game pool.
      const other = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);

      await exclude(m1, a.id, entry).expect(201);

      expect(await gamePoolIds(viewer, b.id)).toEqual([await gameOf(other)]);
      await request(baseUrl).get(`/api/game-collections/${entry}`).set(viewer.headers).expect(404);
      // Its owner reads their own entry, so for them it is in B's game pool.
      expect(await gamePoolIds(m1, b.id)).toEqual(sorted([await gameOf(entry), await gameOf(other)]));
    });
  });

  describe('who may open it', () => {
    it('opens to members and guests, refuses a stranger with 403, and answers 404 for no such household (#367)', async () => {
      const [owner, member, guest, stranger] = [
        await actors.user(),
        await actors.user(),
        await actors.user(),
        await actors.user(),
      ];
      const home = await household(owner, [member, { actor: guest, role: SystemRole.HouseholdGuest }]);
      const entry = await arrangeCollectionEntry(db.client, owner.user.id, Reach.Private);

      // The controls: the household's own members and guests read it.
      expect(await gamePoolIds(member, home.id)).toEqual([await gameOf(entry)]);
      expect(await gamePoolIds(guest, home.id)).toEqual([await gameOf(entry)]);

      await readGamePool(stranger, home.id).expect(403);
      await readGamePool(member, 'no-such-household').expect(404);
    });

    // The game pool reach is a door, not a grant: a friend let in sees only
    // the entries they could already read in that member's collection (#367).
    it("refuses a member's friend while the game pool reach is Private, then lists only what the friend could already read (#367)", async () => {
      const [owner, m1, m2, m3, friend] = [
        await actors.user(),
        await actors.user(),
        await actors.user(),
        await actors.user(),
        await actors.user(),
      ];
      const home = await household(owner, [m1, m2, m3]);
      await befriend(db.client, friend, m1);
      await befriend(db.client, friend, m3);
      await db.client.userPreferences.update({
        where: { userId: m3.user.id },
        data: { showCollectionToFriends: false },
      });
      // m1's Private entry: in the game pool, but no friend reads it.
      const m1sPrivate = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);
      const m1sFriends = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Friends);
      // m2 isn't the friend's friend.
      const m2sFriends = await arrangeCollectionEntry(db.client, m2.user.id, Reach.Friends);
      // m3 is, but doesn't show their collection to friends.
      const m3sFriends = await arrangeCollectionEntry(db.client, m3.user.id, Reach.Friends);

      // The household can't be read by a friend yet.
      await readGamePool(friend, home.id).expect(403);

      // The household reaches friends, its game pool doesn't yet.
      await editHousehold(owner, home.id, { reach: Reach.Friends }).expect(200);
      await request(baseUrl).get(`/api/households/${home.id}`).set(friend.headers).expect(200);
      await readGamePool(friend, home.id).expect(403);

      await editHousehold(owner, home.id, { settings: { gamePoolReach: Reach.Friends } }).expect(200);

      const { games, pagination } = await gamePoolOf(friend, home.id);
      expect(games.map((game) => game.id)).toEqual([await gameOf(m1sFriends)]);
      expect(games[0].owners.map((entry) => entry.collectionEntryId)).toEqual([m1sFriends]);
      expect(pagination.total).toBe(1);

      // The control: a member sees every entry in the game pool.
      expect(await gamePoolIds(owner, home.id)).toEqual(
        sorted(await Promise.all([m1sPrivate, m1sFriends, m2sFriends, m3sFriends].map(gameOf))),
      );
    });

    it('lowers the game pool reach to Private when the household is narrowed, and shuts the friend out again (#367)', async () => {
      const [owner, m1, friend] = [await actors.user(), await actors.user(), await actors.user()];
      const home = await household(owner, [m1]);
      await befriend(db.client, friend, m1);
      const entry = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Friends);

      const widened = createEnvelope(
        await editHousehold(owner, home.id, {
          reach: Reach.Friends,
          settings: { gamePoolReach: Reach.Friends },
        }).expect(200),
        'PATCH /api/households/:id',
      );
      expect(widened.household).toMatchObject({ reach: Reach.Friends, settings: { gamePoolReach: Reach.Friends } });
      // The control: the friend reads the game pool while it reaches them.
      expect(await gamePoolIds(friend, home.id)).toEqual([await gameOf(entry)]);

      const narrowed = createEnvelope(
        await editHousehold(owner, home.id, { reach: Reach.Private }).expect(200),
        'PATCH /api/households/:id',
      );

      expect(narrowed.household).toMatchObject({ reach: Reach.Private, settings: { gamePoolReach: Reach.Private } });
      expect(await gamePoolReachOf(owner, home.id)).toBe(Reach.Private);
      await readGamePool(friend, home.id).expect(403);
    });

    // Coded, so a client can offer to widen the household first (#367).
    it('refuses a game pool reach wider than the household (#367)', async () => {
      const owner = await actors.user();
      const home = await household(owner);
      const wider = { status: 400, code: 'GAME_POOL_REACH_WIDER_THAN_HOUSEHOLD' };

      expectErrorEnvelope(await editHousehold(owner, home.id, { settings: { gamePoolReach: Reach.Friends } }), wider);
      expect(await gamePoolReachOf(owner, home.id)).toBe(Reach.Private);

      // Nor may one patch narrow the household and widen its game pool.
      await editHousehold(owner, home.id, { reach: Reach.Friends }).expect(200);
      expectErrorEnvelope(
        await editHousehold(owner, home.id, { reach: Reach.Private, settings: { gamePoolReach: Reach.Friends } }),
        wider,
      );
      expect(await gamePoolReachOf(owner, home.id)).toBe(Reach.Private);

      // The control: the same setting is accepted once the household reaches friends.
      await editHousehold(owner, home.id, { settings: { gamePoolReach: Reach.Friends } }).expect(200);
      expect(await gamePoolReachOf(owner, home.id)).toBe(Reach.Friends);
    });

    it('refuses wider game pool reaches than Friends (#367)', async () => {
      const owner = await actors.user();
      const home = await household(owner);
      await editHousehold(owner, home.id, { reach: Reach.Friends }).expect(200);

      await editHousehold(owner, home.id, { settings: { gamePoolReach: Reach.Public } }).expect(400);
      await editHousehold(owner, home.id, { settings: { gamePoolReach: null } }).expect(400);
      expect(await gamePoolReachOf(owner, home.id)).toBe(Reach.Private);
    });

    // A settings row the clamp never saw, written straight to the database:
    // the read refuses on its own, so a stale row can't open the game pool
    // to anyone the household doesn't reach (#367).
    it("refuses a member's friend when a stale settings row says Friends on a Private household (#367)", async () => {
      const [owner, m1, friend] = [await actors.user(), await actors.user(), await actors.user()];
      const home = await household(owner, [m1]);
      await befriend(db.client, friend, m1);
      const entry = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Friends);
      await db.client.householdSettings.update({
        where: { householdId: home.id },
        data: { gamePoolReach: Reach.Friends },
      });

      await readGamePool(friend, home.id).expect(403);
      // The control: a member reads it.
      expect(await gamePoolIds(m1, home.id)).toEqual([await gameOf(entry)]);

      // And once the household reaches friends, the same row lets the friend in.
      // Widened through the route, which leaves a Friends game pool reach as
      // it stands, so no write goes behind the server's back after the first
      // authenticated request (#256).
      await editHousehold(owner, home.id, { reach: Reach.Friends }).expect(200);
      expect(await gamePoolIds(friend, home.id)).toEqual([await gameOf(entry)]);
    });

    // Server staff read every household, but the game pool reach opens the
    // game pool to a member's friends, not to everyone who can read the
    // household: a non-member who is no member's friend is refused at either
    // game pool reach (#367).
    it('refuses server staff who are not members or friends at either game pool reach (#367)', async () => {
      const [owner, admin] = [await actors.user(), await actors.admin()];
      const home = await household(owner);
      await arrangeCollectionEntry(db.client, owner.user.id, Reach.Private);

      // Staff read the household itself.
      await request(baseUrl).get(`/api/households/${home.id}`).set(admin.headers).expect(200);
      await readGamePool(admin, home.id).expect(403);

      await editHousehold(owner, home.id, { reach: Reach.Friends, settings: { gamePoolReach: Reach.Friends } }).expect(
        200,
      );

      await readGamePool(admin, home.id).expect(403);
    });
  });
});
