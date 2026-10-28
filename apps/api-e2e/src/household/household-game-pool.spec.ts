import { GameMedium, Reach, SystemRole } from '@bge/database';
import { createActors, createHouseholdWithMembers, type Actors, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { arrangeCollectionEntry } from '../game-collection/game-collection-fixtures';
import { gamePoolSampleEnvelope } from '../game/game-wire';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * `GET /api/households/game-pool/random` samples the game pool across every
 * live household the caller belongs to, and counts its distinct games (#960).
 *
 * An entry is in a household's game pool when its owner has collection
 * sharing on in that household and has not excluded it there, whatever its
 * reach. The caller's own entries count. The game is the unit, so a game two
 * members own is one game, and a game the caller could not open is left out.
 *
 * Each test asserts the sampled games as a set and the count: `size=50` is
 * more than any test arranges, so the sample is the whole game pool.
 */
describe('household game pool sample', () => {
  const baseUrl = requireBaseUrl(process.env);
  const SAMPLE_PATH = '/api/households/game-pool/random';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  /**
   * A household owned by `owner`, with `members` as plain members. Each test
   * creates its actors first, then rosters and rows, before any authenticated
   * request (#256 ordering rule).
   */
  const household = async (owner: SessionActor, members: readonly SessionActor[] = []) => {
    const fixture = await createHouseholdWithMembers(db.client, {
      owner,
      members: members.map((actor) => ({ actor, role: SystemRole.HouseholdMember })),
    });

    const membershipOf = (actor: SessionActor) => {
      const roster = [fixture.owner, ...fixture.members];
      const membership = roster.find((entry) => entry.member.userId === actor.user.id)?.member;
      if (membership === undefined) {
        throw new Error(`the fixture left ${actor.user.id} off the roster`);
      }

      return membership;
    };

    return { id: fixture.household.id, membershipOf };
  };

  const turnSharingOff = (membershipId: string) =>
    db.client.householdMember.update({ where: { id: membershipId }, data: { showAllGames: false } });

  const exclude = (membershipId: string, entryId: string) =>
    db.client.excludedGame.create({ data: { householdMemberId: membershipId, gameCollectionId: entryId } });

  /** The game a collection entry holds. */
  const gameOf = async (entryId: string) =>
    (
      await db.client.gameCollection.findUniqueOrThrow({
        where: { id: entryId },
        select: { platformGame: { select: { gameId: true } } },
      })
    ).platformGame.gameId;

  /** Another collection entry for `ownerId` on the same platform game as `entryId`. */
  const secondCopy = async (entryId: string, ownerId: string) => {
    const { platformGameId } = await db.client.gameCollection.findUniqueOrThrow({
      where: { id: entryId },
      select: { platformGameId: true },
    });

    return db.client.gameCollection.create({
      data: { userId: ownerId, platformGameId, medium: GameMedium.Physical },
      select: { id: true },
    });
  };

  const sampleOf = async (actor: SessionActor, query = 'size=50') => {
    const path = `${SAMPLE_PATH}?${query}`;

    return gamePoolSampleEnvelope(await request(baseUrl).get(path).set(actor.headers).expect(200), `GET ${path}`);
  };

  /** The sampled game ids, sorted, so a test compares the game pool as a set. */
  const gameIdsOf = (envelope: { games: readonly { id: string }[] }) => envelope.games.map((game) => game.id).sort();

  const sorted = (ids: readonly string[]) => [...ids].sort();

  it('unites the game pools of every household the caller belongs to', async () => {
    const [viewer, m1, m2] = [await actors.user(), await actors.user(), await actors.user()];
    await household(viewer, [m1]);
    await household(viewer, [m2]);
    const fromA = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);
    const fromB = await arrangeCollectionEntry(db.client, m2.user.id, Reach.Private);

    const sample = await sampleOf(viewer);

    expect(gameIdsOf(sample)).toEqual(sorted([await gameOf(fromA), await gameOf(fromB)]));
    expect(sample.gameCount).toBe(2);
  });

  it('shows and counts a game two members own once', async () => {
    const [viewer, m1, m2] = [await actors.user(), await actors.user(), await actors.user()];
    await household(viewer, [m1, m2]);
    const entry = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);
    await secondCopy(entry, m2.user.id);

    const sample = await sampleOf(viewer);

    expect(gameIdsOf(sample)).toEqual([await gameOf(entry)]);
    expect(sample.gameCount).toBe(1);
  });

  it("counts the caller's own shared entries", async () => {
    const [viewer, m1] = [await actors.user(), await actors.user()];
    await household(m1, [viewer]);
    const own = await arrangeCollectionEntry(db.client, viewer.user.id, Reach.Private);

    const sample = await sampleOf(viewer);

    expect(gameIdsOf(sample)).toEqual([await gameOf(own)]);
    expect(sample.gameCount).toBe(1);
  });

  it('leaves out an entry whose owner turned collection sharing off, whatever its reach', async () => {
    const [viewer, m1, m2] = [await actors.user(), await actors.user(), await actors.user()];
    const home = await household(viewer, [m1, m2]);
    await arrangeCollectionEntry(db.client, m1.user.id, Reach.Public);
    await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);
    // The control: the sample still reaches this household, so m1's absence
    // is collection sharing's doing.
    const shared = await arrangeCollectionEntry(db.client, m2.user.id, Reach.Private);
    await turnSharingOff(home.membershipOf(m1).id);

    const sample = await sampleOf(viewer);

    expect(gameIdsOf(sample)).toEqual([await gameOf(shared)]);
    expect(sample.gameCount).toBe(1);
  });

  it('leaves out an entry excluded from the household', async () => {
    const [viewer, m1] = [await actors.user(), await actors.user()];
    const home = await household(viewer, [m1]);
    const excluded = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);
    const kept = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);
    await exclude(home.membershipOf(m1).id, excluded);

    const sample = await sampleOf(viewer);

    expect(gameIdsOf(sample)).toEqual([await gameOf(kept)]);
    expect(sample.gameCount).toBe(1);
  });

  // The caller can read this entry through its reach, but it is
  // in none of the caller's households' game pools. The exact rule is what
  // keeps it out; the GameCollection ceiling alone would serve it.
  it("leaves out a Public entry its owner shares only in a household the caller isn't in", async () => {
    const [viewer, m1] = [await actors.user(), await actors.user()];
    const shared = await household(viewer, [m1]);
    await household(m1);
    const entry = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Public);
    await turnSharingOff(shared.membershipOf(m1).id);

    const sample = await sampleOf(viewer);

    expect(gameIdsOf(sample)).toEqual([]);
    expect(sample.gameCount).toBe(0);
    await request(baseUrl).get(`/api/game-collections/${entry}`).set(viewer.headers).expect(200);
  });

  // By the exact rule this entry is in B's game pool. But the permission
  // catalog's household rule (`read:game_collection:household`) cannot tie an
  // exclusion to the household it was made in, so an exclusion in any
  // household the two share hides the entry from the collection read. The
  // sample follows that ceiling and never serves more than it (#960).
  it('leaves out an entry excluded from one shared household and shared in another, as the collection read does', async () => {
    const [viewer, m1] = [await actors.user(), await actors.user()];
    const a = await household(viewer, [m1]);
    await household(viewer, [m1]);
    const entry = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);
    await exclude(a.membershipOf(m1).id, entry);

    const sample = await sampleOf(viewer);

    expect(gameIdsOf(sample)).toEqual([]);
    expect(sample.gameCount).toBe(0);
    await request(baseUrl).get(`/api/game-collections/${entry}`).set(viewer.headers).expect(404);
  });

  it('drops a deleted household from the game pool', async () => {
    const [viewer, m1] = [await actors.user(), await actors.user()];
    const home = await household(m1, [viewer]);
    const entry = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);

    // Sampled while the household is live, so the empty sample after is the
    // delete's doing.
    expect(gameIdsOf(await sampleOf(viewer))).toEqual([await gameOf(entry)]);

    await request(baseUrl).delete(`/api/households/${home.id}`).set(m1.headers).expect(200);

    const sample = await sampleOf(viewer);
    expect(gameIdsOf(sample)).toEqual([]);
    expect(sample.gameCount).toBe(0);
  });

  // The stats card (client#614) shows its prompt from this answer, so it is
  // an empty sample, never a refusal. Other households hold games, so the
  // empty answer is the caller's, not the server's.
  it('answers an empty sample and a zero count to a caller with no household', async () => {
    const [viewer, m1, m2] = [await actors.user(), await actors.user(), await actors.user()];
    await household(m1, [m2]);
    await arrangeCollectionEntry(db.client, m2.user.id, Reach.Public);

    const response = await request(baseUrl).get(`${SAMPLE_PATH}?size=50`).set(viewer.headers).expect(200);

    expect(response.body).toEqual({ games: [], gameCount: 0 });
  });

  // While #492 is open no route lets a member collect a game they cannot
  // read, so the database seeds it.
  it("leaves out a game the caller can't open, though a member collected it", async () => {
    const [viewer, m1, stranger] = [await actors.user(), await actors.user(), await actors.user()];
    await household(viewer, [m1]);
    const platform = await db.client.platform.findUniqueOrThrow({ where: { slug: 'tabletop' }, select: { id: true } });
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
    // The control: m1's other entry is in the sample.
    const visible = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);

    const sample = await sampleOf(viewer);

    expect(gameIdsOf(sample)).toEqual([await gameOf(visible)]);
    expect(sample.gameCount).toBe(1);
    await request(baseUrl).get(`/api/games/${hidden.id}`).set(viewer.headers).expect(403);
  });

  // Fewer games than size: every game comes back once, none twice.
  it('samples size games and counts them all', async () => {
    const [viewer, m1] = [await actors.user(), await actors.user()];
    await household(viewer, [m1]);
    const entries = await Promise.all(
      [0, 1, 2].map(() => arrangeCollectionEntry(db.client, m1.user.id, Reach.Private)),
    );
    const games = sorted(await Promise.all(entries.map(gameOf)));

    const one = await sampleOf(viewer, 'size=1');
    expect(one.games).toHaveLength(1);
    expect(games).toContain(one.games[0].id);
    expect(one.gameCount).toBe(3);

    const unsized = await sampleOf(viewer, '');
    expect(gameIdsOf(unsized)).toEqual(games);
    expect(unsized.gameCount).toBe(3);
  });

  // The full range of refused sizes is pinned on `GET /games/random`; this
  // shows the household route binds the same query.
  it('refuses size=0', async () => {
    const viewer = await actors.user();

    await request(baseUrl).get(`${SAMPLE_PATH}?size=0`).set(viewer.headers).expect(400);
  });
});
