import { Reach, ResourceType, SystemRole } from '@bge/database';
import type { Actors, HouseholdRoleName, SessionActor } from '@bge/testing-e2e';
import { createActors, createHouseholdWithMembers, pollUntil } from '@bge/testing-e2e';
import request from 'supertest';
import { arrangeCollectionEntry } from '../game-collection/game-collection-fixtures';
import { gamePoolSampleEnvelope } from '../game/game-wire';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import {
  excludedGameEnvelope,
  excludedGamesEnvelope,
  gamePoolEnvelope,
  memberEnvelope,
  memberGameSampleIds,
} from './household-wire';

/**
 * A member's own say over how their games join a household's game pool,
 * against the running server: their collection sharing, through
 * `PATCH /api/households/:id/members/me`, and their excluded games (#170),
 * through `…/members/me/excluded-games` (#170).
 *
 * Each route acts on the caller's own membership, whatever their household
 * role: an owner's grant reaches every member's row, so the tests that matter
 * most are the owner's. Each effect is read back through the game pool reads,
 * `GET /api/households/:id/games` and the game pool sample, beside a control
 * that shows the read still reaches the household.
 *
 * Each test creates its actors, then the rosters and rows, before any
 * authenticated request (#256 ordering rule).
 */
describe('collection sharing and excluded games (#170)', () => {
  const baseUrl = requireBaseUrl(process.env);

  /** How long the audit listener may take to write an entry after the request has answered. */
  const AUDIT_ENTRY_LANDS_MS = 5_000;

  const COLLECTION_SHARING_CHANGED = 'household.member.collection_sharing_changed';
  const EXCLUDED_GAME_ADDED = 'household.member.excluded_game_added';
  const EXCLUDED_GAME_REMOVED = 'household.member.excluded_game_removed';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const mePath = (householdId: string) => `/api/households/${householdId}/members/me`;
  const excludedGamesPath = (householdId: string) => `${mePath(householdId)}/excluded-games`;

  /**
   * A household owned by `owner`, with each of `members` in the role given,
   * a plain member by default.
   */
  const household = async (
    owner: SessionActor,
    members: readonly (SessionActor | { actor: SessionActor; role: HouseholdRoleName })[] = [],
  ) => {
    const fixture = await createHouseholdWithMembers(db.client, {
      owner,
      members: members.map((entry) => ('role' in entry ? entry : { actor: entry, role: SystemRole.HouseholdMember })),
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

  const setCollectionSharing = (actor: SessionActor, householdId: string, collectionSharing: boolean) =>
    request(baseUrl).patch(mePath(householdId)).set(actor.headers).send({ collectionSharing });

  const exclude = (actor: SessionActor, householdId: string, collectionEntryId: string, reason?: string) =>
    request(baseUrl)
      .post(excludedGamesPath(householdId))
      .set(actor.headers)
      .send(reason === undefined ? { collectionEntryId } : { collectionEntryId, reason });

  const include = (actor: SessionActor, householdId: string, collectionEntryId: string) =>
    request(baseUrl)
      .delete(`${excludedGamesPath(householdId)}/${collectionEntryId}`)
      .set(actor.headers);

  const excludedGamesOf = async (actor: SessionActor, householdId: string) =>
    excludedGamesEnvelope(
      await request(baseUrl).get(excludedGamesPath(householdId)).set(actor.headers).expect(200),
      'GET /api/households/:id/members/me/excluded-games',
    ).excludedGames;

  /** The ids of the games on the first page of the household's game pool, sorted. */
  const gamePoolOf = async (actor: SessionActor, householdId: string) =>
    gamePoolEnvelope(
      await request(baseUrl).get(`/api/households/${householdId}/games?limit=100`).set(actor.headers).expect(200),
      'GET /api/households/:id/games',
    );

  const gamePoolIds = async (actor: SessionActor, householdId: string) =>
    (await gamePoolOf(actor, householdId)).games.map((game) => game.id).sort();

  const sampleIds = async (actor: SessionActor) =>
    gamePoolSampleEnvelope(
      await request(baseUrl).get('/api/households/game-pool/random?size=50').set(actor.headers).expect(200),
      'GET /api/households/game-pool/random',
    )
      .games.map((game) => game.id)
      .sort();

  /** The game a collection entry holds. */
  const gameOf = async (entryId: string) =>
    (
      await db.client.gameCollection.findUniqueOrThrow({
        where: { id: entryId },
        select: { platformGame: { select: { gameId: true } } },
      })
    ).platformGame.gameId;

  /** The collection entries `GET /api/households/:id` samples for one member, sorted (#514). */
  const memberSampleOf = async (viewer: SessionActor, householdId: string, member: SessionActor) =>
    memberGameSampleIds(
      await request(baseUrl).get(`/api/households/${householdId}`).set(viewer.headers).expect(200),
      'GET /api/households/:id',
      member.user.id,
    ).sort();

  const sorted = (ids: readonly string[]) => [...ids].sort();

  /** The refusals a client can branch on, by their stable code (#170). */
  const COLLECTION_ENTRY_NOT_FOUND = { status: 404, code: 'COLLECTION_ENTRY_NOT_FOUND' };
  const EXCLUDED_GAME_NOT_FOUND = { status: 404, code: 'EXCLUDED_GAME_NOT_FOUND' };

  /** The household's audit entries for `event`, oldest first, once there are `count` of them. */
  const householdEntriesOnce = (householdId: string, event: string, count = 1) =>
    pollUntil(
      async () => {
        const entries = await db.client.auditLog.findMany({
          where: { subject: ResourceType.Household, subjectId: householdId, event },
          orderBy: { occurredAt: 'asc' },
        });

        return entries.length >= count ? entries : undefined;
      },
      { description: `${count} ${event} audit entries for household ${householdId}`, timeoutMs: AUDIT_ENTRY_LANDS_MS },
    );

  it("takes a member's games out of the household's game pool and the sample when they turn collection sharing off (#170)", async () => {
    const [viewer, m1, m2] = [await actors.user(), await actors.user(), await actors.user()];
    const home = await household(viewer, [m1, m2]);
    const offEntry = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);
    // The control: m2 keeps sharing, so the reads still reach this household.
    const keptEntry = await arrangeCollectionEntry(db.client, m2.user.id, Reach.Private);
    const [off, kept] = [await gameOf(offEntry), await gameOf(keptEntry)];

    expect(await gamePoolIds(viewer, home.id)).toEqual(sorted([off, kept]));

    const { member } = memberEnvelope(
      await setCollectionSharing(m1, home.id, false).expect(200),
      'PATCH /api/households/:id/members/me',
    );
    expect(member).toMatchObject({ id: home.membershipOf(m1).id, userId: m1.user.id, collectionSharing: false });

    expect(await gamePoolIds(viewer, home.id)).toEqual([kept]);
    expect(await sampleIds(viewer)).toEqual([kept]);

    await setCollectionSharing(m1, home.id, true).expect(200);

    expect(await gamePoolIds(viewer, home.id)).toEqual(sorted([off, kept]));
  });

  // The member game sample `GET /api/households/:id` embeds reads the same
  // two writes: turning collection sharing off leaves what the reach admits on
  // its own, and an excluded game is left out whatever its reach (#170).
  it("takes a member's games out of their game sample on the household when they turn collection sharing off and exclude a game (#170)", async () => {
    const [viewer, m1] = [await actors.user(), await actors.user()];
    const home = await household(viewer, [m1]);
    const unsharedEntry = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);
    // Public, so only the excluded game keeps it out once sharing is off.
    const excludedEntry = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Public);
    // The control: a Public entry the member neither excludes nor needs to share.
    const keptEntry = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Public);

    expect(await memberSampleOf(viewer, home.id, m1)).toEqual(sorted([unsharedEntry, excludedEntry, keptEntry]));

    await setCollectionSharing(m1, home.id, false).expect(200);
    await exclude(m1, home.id, excludedEntry).expect(201);

    expect(await memberSampleOf(viewer, home.id, m1)).toEqual([keptEntry]);
  });

  // An owner's `manage` on HouseholdMember reaches every row of the roster,
  // so "me" has to be pinned to the caller (#170).
  it("changes only the owner's own row when the owner turns collection sharing off (#170)", async () => {
    const [owner, m1] = [await actors.user(), await actors.user()];
    const home = await household(owner, [m1]);

    const { member } = memberEnvelope(
      await setCollectionSharing(owner, home.id, false).expect(200),
      'PATCH /api/households/:id/members/me as the owner',
    );

    expect(member).toMatchObject({ id: home.membershipOf(owner).id, userId: owner.user.id, collectionSharing: false });
    const rowOf = (actor: SessionActor) =>
      db.client.householdMember.findUniqueOrThrow({
        where: { id: home.membershipOf(actor).id },
        select: { collectionSharing: true },
      });
    await expect(rowOf(owner)).resolves.toEqual({ collectionSharing: false });
    await expect(rowOf(m1)).resolves.toEqual({ collectionSharing: true });
  });

  // The global pipe's implicit conversion would read the string 'false' as
  // true, turning collection sharing on (#170).
  it('refuses a collectionSharing that is not a JSON boolean (#170)', async () => {
    const [owner, m1] = [await actors.user(), await actors.user()];
    const home = await household(owner, [m1]);

    await setCollectionSharing(m1, home.id, 'false' as unknown as boolean).expect(400);
    await request(baseUrl).patch(mePath(home.id)).set(m1.headers).send({}).expect(400);

    // The control: the same caller's JSON boolean is accepted.
    await setCollectionSharing(m1, home.id, false).expect(200);
  });

  // A user in no household holds no grant to update a HouseholdMember, so the
  // writes' type-level gate refuses them, as it refuses a non-member's update
  // on the other member routes. Every user may read some HouseholdMember rows,
  // so the list passes its gate, and so does a member of another household on
  // every route: the service, finding no membership here, answers 404
  // (#170).
  it('refuses a user outside the household, and changes nothing (#170)', async () => {
    const [owner, stranger, elsewhere] = [await actors.user(), await actors.user(), await actors.user()];
    const home = await household(owner);
    const elsewheresHome = await household(elsewhere);
    const strangersEntry = await arrangeCollectionEntry(db.client, stranger.user.id, Reach.Private);
    const elsewheresEntry = await arrangeCollectionEntry(db.client, elsewhere.user.id, Reach.Private);

    await setCollectionSharing(stranger, home.id, false).expect(403);
    await exclude(stranger, home.id, strangersEntry).expect(403);
    await request(baseUrl).get(excludedGamesPath(home.id)).set(stranger.headers).expect(404);

    await setCollectionSharing(elsewhere, home.id, false).expect(404);
    await exclude(elsewhere, home.id, elsewheresEntry).expect(404);
    await request(baseUrl).get(excludedGamesPath(home.id)).set(elsewhere.headers).expect(404);

    await expect(
      db.client.excludedGame.count({ where: { gameCollectionId: { in: [strangersEntry, elsewheresEntry] } } }),
    ).resolves.toBe(0);
    const sharingOf = (membershipId: string) =>
      db.client.householdMember.findUniqueOrThrow({ where: { id: membershipId }, select: { collectionSharing: true } });
    // No refused toggle reached a row: not this household's, nor the one
    // `elsewhere` belongs to.
    await expect(sharingOf(home.membershipOf(owner).id)).resolves.toEqual({ collectionSharing: true });
    await expect(sharingOf(elsewheresHome.membershipOf(elsewhere).id)).resolves.toEqual({ collectionSharing: true });
    // The control: the owner's own calls on the same household are answered.
    await setCollectionSharing(owner, home.id, false).expect(200);
    await request(baseUrl).get(excludedGamesPath(home.id)).set(owner.headers).expect(200);
  });

  it('excludes an entry from this household only (#170)', async () => {
    const [ownerA, ownerB, m1] = [await actors.user(), await actors.user(), await actors.user()];
    const a = await household(ownerA, [m1]);
    const b = await household(ownerB, [m1]);
    const excludedEntry = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);
    // The control: m1's other entry stays in A's game pool.
    const keptEntry = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);
    const [excluded, kept] = [await gameOf(excludedEntry), await gameOf(keptEntry)];

    const { excludedGame } = excludedGameEnvelope(
      await exclude(m1, a.id, excludedEntry, 'Lent to my sister').expect(201),
      'POST /api/households/:id/members/me/excluded-games',
    );
    expect(excludedGame).toMatchObject({
      collectionEntryId: excludedEntry,
      reason: 'Lent to my sister',
      platformGame: { game: { id: excluded } },
    });

    expect(await gamePoolIds(ownerA, a.id)).toEqual([kept]);
    expect(await gamePoolIds(ownerB, b.id)).toEqual(sorted([excluded, kept]));

    expect((await excludedGamesOf(m1, a.id)).map((entry) => entry.collectionEntryId)).toEqual([excludedEntry]);
    expect(await excludedGamesOf(m1, b.id)).toEqual([]);
    await expect(
      db.client.excludedGame.findMany({
        where: { gameCollectionId: excludedEntry },
        select: { householdMemberId: true },
      }),
    ).resolves.toEqual([{ householdMemberId: a.membershipOf(m1).id }]);
  });

  // The id is one every game pool read hands out, so the answer must not
  // tell another member's entry apart from a missing one (#170).
  it("answers 404 to an owner excluding another member's entry, and records nothing (#170)", async () => {
    const [owner, m1] = [await actors.user(), await actors.user()];
    const home = await household(owner, [m1]);
    const membersEntry = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);
    const ownEntry = await arrangeCollectionEntry(db.client, owner.user.id, Reach.Private);

    const pool = await gamePoolOf(owner, home.id);
    const handedOut = pool.games
      .flatMap((game) => game.owners)
      .find((entry) => entry.memberId === home.membershipOf(m1).id)?.collectionEntryId;
    expect(handedOut).toBe(membersEntry);

    const foreign = await exclude(owner, home.id, membersEntry, 'Not yours to hold back');
    const missing = await exclude(owner, home.id, 'no-such-entry');

    expectErrorEnvelope(foreign, COLLECTION_ENTRY_NOT_FOUND);
    expectErrorEnvelope(missing, COLLECTION_ENTRY_NOT_FOUND);
    expect(foreign.body).toEqual(missing.body);

    await expect(db.client.excludedGame.count({ where: { gameCollectionId: membersEntry } })).resolves.toBe(0);
    expect(await gamePoolIds(owner, home.id)).toEqual(sorted([await gameOf(membersEntry), await gameOf(ownEntry)]));

    // The control: the owner's own entry is excluded through the same route.
    await exclude(owner, home.id, ownEntry).expect(201);
    expect(await gamePoolIds(owner, home.id)).toEqual([await gameOf(membersEntry)]);

    // The control's entry is the only one recorded: the 404s published nothing.
    const added = await householdEntriesOnce(home.id, EXCLUDED_GAME_ADDED);
    expect(added).toHaveLength(1);
    expect(added[0]?.payload).toMatchObject({ after: { collectionEntryId: ownEntry } });
  });

  it('lets a guest exclude their own entry (#170)', async () => {
    const [owner, guest] = [await actors.user(), await actors.user()];
    const home = await household(owner, [{ actor: guest, role: SystemRole.HouseholdGuest }]);
    const guestsEntry = await arrangeCollectionEntry(db.client, guest.user.id, Reach.Private);
    const ownersEntry = await arrangeCollectionEntry(db.client, owner.user.id, Reach.Private);
    const [guests, owners] = [await gameOf(guestsEntry), await gameOf(ownersEntry)];

    // The guest's entry is in the game pool until they exclude it.
    expect(await gamePoolIds(owner, home.id)).toEqual(sorted([guests, owners]));

    await exclude(guest, home.id, guestsEntry).expect(201);

    expect((await excludedGamesOf(guest, home.id)).map((entry) => entry.collectionEntryId)).toEqual([guestsEntry]);
    expect(await gamePoolIds(owner, home.id)).toEqual([owners]);
  });

  it('replaces the reason when an excluded game is excluded again, and clears it when one is sent without a reason (#170)', async () => {
    const [owner, m1] = [await actors.user(), await actors.user()];
    const home = await household(owner, [m1]);
    const entry = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);
    const route = 'POST /api/households/:id/members/me/excluded-games';

    const first = excludedGameEnvelope(await exclude(m1, home.id, entry, 'Too long for weeknights').expect(201), route);
    const second = excludedGameEnvelope(await exclude(m1, home.id, entry, 'Missing a piece').expect(201), route);

    expect(second.excludedGame.reason).toBe('Missing a piece');
    // A repeat keeps when it was first excluded.
    expect(second.excludedGame.excludedAt).toBe(first.excludedGame.excludedAt);
    expect(await excludedGamesOf(m1, home.id)).toEqual([second.excludedGame]);

    const omitted = excludedGameEnvelope(await exclude(m1, home.id, entry).expect(201), route);
    expect(omitted.excludedGame.reason).toBeNull();

    // A reason of only spaces reads as none, so it clears one too.
    const again = excludedGameEnvelope(await exclude(m1, home.id, entry, 'Again').expect(201), route);
    expect(again.excludedGame.reason).toBe('Again');
    const blank = excludedGameEnvelope(await exclude(m1, home.id, entry, '   ').expect(201), route);
    expect(blank.excludedGame.reason).toBeNull();

    await expect(db.client.excludedGame.count({ where: { gameCollectionId: entry } })).resolves.toBe(1);
  });

  it('answers 404 to putting back a game that is not excluded (#170)', async () => {
    const [owner, m1] = [await actors.user(), await actors.user()];
    const home = await household(owner, [m1]);
    const neverExcluded = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);
    const entry = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);

    expectErrorEnvelope(await include(m1, home.id, neverExcluded), EXCLUDED_GAME_NOT_FOUND);

    // The control: an excluded game is put back, once.
    await exclude(m1, home.id, entry).expect(201);
    expect(await gamePoolIds(owner, home.id)).toEqual([await gameOf(neverExcluded)]);

    const removed = await include(m1, home.id, entry).expect(200);
    expect(removed.body).toEqual({ message: expect.any(String) });
    expect(await gamePoolIds(owner, home.id)).toEqual(sorted([await gameOf(neverExcluded), await gameOf(entry)]));

    expectErrorEnvelope(await include(m1, home.id, entry), EXCLUDED_GAME_NOT_FOUND);
  });

  // The reason is the member's own note: no audit entry or webhook carries it
  // (#170). Only a change is recorded, so a repeat writes no second entry.
  it('records each change in the audit log, attributed to the member, with no reason in any entry (#170)', async () => {
    const [owner, m1] = [await actors.user(), await actors.user()];
    const home = await household(owner, [m1]);
    const entry = await arrangeCollectionEntry(db.client, m1.user.id, Reach.Private);
    const reason = 'A secret reason only m1 sees';
    const membership = { householdId: home.id, memberId: home.membershipOf(m1).id, userId: m1.user.id };
    const attributed = { actorKind: 'user', actorUserId: m1.user.id, action: 'update' };

    await setCollectionSharing(m1, home.id, false).expect(200);
    await exclude(m1, home.id, entry, reason).expect(201);
    await exclude(m1, home.id, entry, `${reason}, edited`).expect(201);
    await include(m1, home.id, entry).expect(200);

    // The removal's entry lands after the others, so once it is in, the
    // counts of the earlier ones are final.
    const removed = await householdEntriesOnce(home.id, EXCLUDED_GAME_REMOVED);
    const [sharing, added] = [
      await householdEntriesOnce(home.id, COLLECTION_SHARING_CHANGED),
      await householdEntriesOnce(home.id, EXCLUDED_GAME_ADDED),
    ];

    expect(sharing).toEqual([
      expect.objectContaining({
        ...attributed,
        payload: {
          before: { ...membership, collectionSharing: true },
          after: { ...membership, collectionSharing: false },
        },
      }),
    ]);
    // The repeat that changed only the reason wrote none.
    expect(added).toEqual([
      expect.objectContaining({
        ...attributed,
        payload: {
          before: { ...membership, collectionEntryId: null },
          after: { ...membership, collectionEntryId: entry },
        },
      }),
    ]);
    expect(removed).toEqual([
      expect.objectContaining({
        ...attributed,
        payload: {
          before: { ...membership, collectionEntryId: entry },
          after: { ...membership, collectionEntryId: null },
        },
      }),
    ]);

    // Under any subject, so a reason recorded against another one is caught too.
    const everyEntry = await db.client.auditLog.findMany({
      where: { OR: [{ subjectId: home.id }, { actorUserId: m1.user.id }] },
    });
    expect(JSON.stringify(everyEntry)).not.toContain('secret reason');
  });
});
