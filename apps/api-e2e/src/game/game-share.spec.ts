import { FriendshipStatus, MemberSharePolicy, Reach, SystemRole, type DatabaseService } from '@bge/database';
import { ServiceAccountService } from '@bge/services';
import { arrangeFriendship, createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { gameShareEnvelope, listGameSharesEnvelope } from './game-share-wire';
import { listGamesEnvelope, localSearchGameIds } from './game-wire';

/**
 * Sharing a game with a named user or a household, from the game's side
 * (#810), against real rows.
 *
 * A share shows a game to its recipient on top of its reach. Only the game's
 * owner shares it, and the service reads the game as the acting user's own,
 * live game: the server's Owner passes every permission check through
 * `manage:all`, so that read, and the roster read for a household, are what
 * refuse them a game or a household that isn't theirs. A block between the
 * owner and a named recipient refuses the share, and vetoes one already made.
 *
 * A game that exists and that the caller may not read answers 403 at
 * `GET /games/:id`, as `game-authorization.spec.ts` pins, so that is the
 * refusal the reads below expect.
 *
 * A share in effect also puts the game in its recipient's `GET /games` and
 * local title search, which read the same set; one still waiting for approval,
 * or into a household that is soft-deleted, is in neither.
 *
 * Every denial below is paired with a control on the same row or the same
 * route, so it cannot pass because the row was unreadable to everyone or the
 * route answered nothing.
 */
describe('game shares', () => {
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

  const readGame = (actor: AuthenticatedActor, id: string) =>
    request(baseUrl).get(`${GAMES_PATH}/${id}`).set(actor.headers);

  const shareGame = (actor: AuthenticatedActor, gameId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(`${GAMES_PATH}/${gameId}/shares`).set(actor.headers).send(body);

  const listShares = (actor: AuthenticatedActor, gameId: string) =>
    request(baseUrl).get(`${GAMES_PATH}/${gameId}/shares`).set(actor.headers);

  const removeShare = (actor: AuthenticatedActor, gameId: string, shareId: string) =>
    request(baseUrl).delete(`${GAMES_PATH}/${gameId}/shares/${shareId}`).set(actor.headers);

  // External gateways are left out: this suite runs no coordinator, and the
  // local half is the one that reads the Game table.
  const searchGames = (actor: AuthenticatedActor, query: string) =>
    request(baseUrl).get(`${GAMES_PATH}/search`).query({ query, includeExternal: false }).set(actor.headers);

  const listedIds = async (actor: AuthenticatedActor, who: string) =>
    listGamesEnvelope(await request(baseUrl).get(GAMES_PATH).set(actor.headers).expect(200), `GET /api/games as ${who}`)
      .games.map((game) => game.id)
      .sort();

  const searchedIds = async (actor: AuthenticatedActor, query: string, who: string) =>
    localSearchGameIds(await searchGames(actor, query).expect(200), `GET /api/games/search as ${who}`)
      .slice()
      .sort();

  /** The share a 201 hands back, parsed. */
  const sharedWith = async (actor: AuthenticatedActor, gameId: string, body: Record<string, unknown>) =>
    gameShareEnvelope(await shareGame(actor, gameId, body).expect(201), `POST /api/games/:id/shares`).share;

  /** A refusal's status and message, so a 404 can be told apart by the id it names. */
  const refusal = (response: { status: number; body: unknown }) => ({
    status: response.status,
    message: (response.body as { message?: unknown } | null)?.message ?? null,
  });

  const arrangeGame = (createdById: string, reach: Reach, title = `e2e game ${randomUUID().slice(0, 8)}`) =>
    db.client.game.create({ data: { title, reach, createdById }, select: { id: true } });

  /** The server's service account, ensured the way the import path ensures it. */
  const serviceAccount = () => new ServiceAccountService(db.client as unknown as DatabaseService).resolveOrEnsure();

  /** Lifts a block, as its blocker's unfriend does: the pair's row goes. */
  const unblock = (a: AuthenticatedActor, b: AuthenticatedActor) =>
    db.client.friendship.deleteMany({ where: { pairKey: [a.user.id, b.user.id].sort().join(':') } });

  describe('to a user', () => {
    it('lets the owner share a Private game with a user, who then reads it by id', async () => {
      const [owner, recipient, stranger] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      const game = await arrangeGame(owner.user.id, Reach.Private);

      // Before the share, the recipient is refused like anyone else.
      await readGame(recipient, game.id).expect(403);

      const share = await sharedWith(owner, game.id, { userId: recipient.user.id });

      expect(share).toMatchObject({
        gameId: game.id,
        userId: recipient.user.id,
        householdId: null,
        sharedById: owner.user.id,
        approvedById: null,
      });
      // A share to a user takes effect at once.
      expect(share.approvedAt).not.toBeNull();

      await readGame(recipient, game.id).expect(200);
      // The control: the share admits its recipient and nobody else.
      await readGame(stranger, game.id).expect(403);
    });

    it('refuses to share a game the actor did not create, even for the Owner', async () => {
      const [creator, other, recipient] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      const serverOwner = await actors.owner();
      // Public, so the other user reads it: the refusal is about creating it.
      const game = await arrangeGame(creator.user.id, Reach.Public);

      for (const actor of [other, serverOwner]) {
        expect(refusal(await shareGame(actor, game.id, { userId: recipient.user.id }))).toEqual({
          status: 403,
          message: expect.stringMatching(new RegExp(`only the person who created game ${game.id}`, 'i')),
        });
      }

      // The control: its creator shares the same game with the same recipient.
      await sharedWith(creator, game.id, { userId: recipient.user.id });
    });

    it('refuses a soft-deleted game as not found, and a service-owned game as not theirs', async () => {
      const [owner, recipient] = await Promise.all([actors.user(), actors.user()]);
      const serverOwner = await actors.owner();
      const removed = await arrangeGame(owner.user.id, Reach.Public);
      await db.client.game.update({ where: { id: removed.id }, data: { deletedAt: new Date() } });
      const imported = await arrangeGame((await serviceAccount()).id, Reach.Public);

      expect(refusal(await shareGame(owner, removed.id, { userId: recipient.user.id }))).toEqual({
        status: 404,
        message: expect.stringContaining(removed.id),
      });
      // The Owner's `manage:all` passes every permission check, so who created
      // the game is what refuses them the server's own game. It is live and
      // public, so the refusal is 403.
      expect(refusal(await shareGame(serverOwner, imported.id, { userId: recipient.user.id }))).toEqual({
        status: 403,
        message: expect.stringMatching(new RegExp(`only the person who created game ${imported.id}`, 'i')),
      });

      // The control: the same owner shares a live game of theirs.
      const live = await arrangeGame(owner.user.id, Reach.Public);
      await sharedWith(owner, live.id, { userId: recipient.user.id });
    });

    it('refuses yourself, the service account and an anonymous user as the recipient', async () => {
      const [owner, recipient] = await Promise.all([actors.user(), actors.user()]);
      const anonymous = await actors.anonymous();
      const service = await serviceAccount();
      const game = await arrangeGame(owner.user.id, Reach.Private);

      await shareGame(owner, game.id, { userId: owner.user.id }).expect(400);
      expect(refusal(await shareGame(owner, game.id, { userId: service.id }))).toEqual({
        status: 404,
        message: expect.stringContaining(service.id),
      });
      expect(refusal(await shareGame(owner, game.id, { userId: anonymous.user.id }))).toEqual({
        status: 404,
        message: expect.stringContaining(anonymous.user.id),
      });

      // The control: a registered user is shared with on the same game.
      await sharedWith(owner, game.id, { userId: recipient.user.id });
      expect(await db.client.gameShare.count({ where: { gameId: game.id } })).toBe(1);
    });

    it('refuses a recipient when a block stands between the two, whichever placed it', async () => {
      const [owner, blockedByOwner, blockerOfOwner, unblocked] = await Promise.all([
        actors.user(),
        actors.user(),
        actors.user(),
        actors.user(),
      ]);
      await arrangeFriendship(db.client, owner, blockedByOwner, FriendshipStatus.Blocked);
      await arrangeFriendship(db.client, blockerOfOwner, owner, FriendshipStatus.Blocked);
      const game = await arrangeGame(owner.user.id, Reach.Private);

      await shareGame(owner, game.id, { userId: blockedByOwner.user.id }).expect(403);
      await shareGame(owner, game.id, { userId: blockerOfOwner.user.id }).expect(403);

      // The control: the same owner, game and route, to a recipient with no block.
      await sharedWith(owner, game.id, { userId: unblocked.user.id });
      expect(await db.client.gameShare.count({ where: { gameId: game.id } })).toBe(1);
    });

    it('hides a shared game from its recipient once a block is placed, by either of them, and shows it again after the unblock', async () => {
      const [owner, recipient] = await Promise.all([actors.user(), actors.user()]);
      const game = await arrangeGame(owner.user.id, Reach.Private);
      await sharedWith(owner, game.id, { userId: recipient.user.id });

      await readGame(recipient, game.id).expect(200);

      for (const [blocker, blocked] of [
        [owner, recipient],
        [recipient, owner],
      ] as const) {
        await arrangeFriendship(db.client, blocker, blocked, FriendshipStatus.Blocked);
        await readGame(recipient, game.id).expect(403);
        // The share outlives the block: lifting it shows the game again.
        await unblock(blocker, blocked);
        await readGame(recipient, game.id).expect(200);
      }
    });
  });

  it('answers 409 for the same recipient twice', async () => {
    const [owner, recipient] = await Promise.all([actors.user(), actors.user()]);
    const { household } = await actors.householdWithMembers({ owner });
    const game = await arrangeGame(owner.user.id, Reach.Private);

    await sharedWith(owner, game.id, { userId: recipient.user.id });
    await shareGame(owner, game.id, { userId: recipient.user.id }).expect(409);

    await sharedWith(owner, game.id, { householdId: household.id });
    await shareGame(owner, game.id, { householdId: household.id }).expect(409);

    expect(await db.client.gameShare.count({ where: { gameId: game.id } })).toBe(2);
  });

  it('answers 400 for neither recipient and for both', async () => {
    const [owner, recipient] = await Promise.all([actors.user(), actors.user()]);
    const { household } = await actors.householdWithMembers({ owner });
    const game = await arrangeGame(owner.user.id, Reach.Private);

    await shareGame(owner, game.id, {}).expect(400);
    await shareGame(owner, game.id, { userId: recipient.user.id, householdId: household.id }).expect(400);
    expect(await db.client.gameShare.count({ where: { gameId: game.id } })).toBe(0);

    // The control: either recipient alone is shared with.
    await sharedWith(owner, game.id, { userId: recipient.user.id });
    await sharedWith(owner, game.id, { householdId: household.id });
  });

  it("lists a game's shares to its owner and to no one else", async () => {
    const [owner, recipient, stranger] = await Promise.all([actors.user(), actors.user(), actors.user()]);
    const game = await arrangeGame(owner.user.id, Reach.Public);
    const share = await sharedWith(owner, game.id, { userId: recipient.user.id });

    const ownersPage = listGameSharesEnvelope(await listShares(owner, game.id).expect(200), 'as the owner');
    expect(ownersPage.shares.map((row) => row.id)).toEqual([share.id]);
    expect(ownersPage.total).toBe(1);

    // The game is Public, so both read it: the empty pages are about the shares.
    for (const [who, actor] of [
      ['the recipient', recipient],
      ['a stranger', stranger],
    ] as const) {
      await readGame(actor, game.id).expect(200);
      const page = listGameSharesEnvelope(await listShares(actor, game.id).expect(200), `as ${who}`);
      expect(page.shares).toEqual([]);
      expect(page.total).toBe(0);
    }
  });

  it('lets the sharer remove a share, after which the recipient reads 403', async () => {
    const [owner, recipient, stranger] = await Promise.all([actors.user(), actors.user(), actors.user()]);
    const game = await arrangeGame(owner.user.id, Reach.Private);
    const share = await sharedWith(owner, game.id, { userId: recipient.user.id });

    await readGame(recipient, game.id).expect(200);

    // Only the sharer removes it: a stranger is refused, and the share stands.
    await removeShare(stranger, game.id, share.id).expect(403);
    await readGame(recipient, game.id).expect(200);

    await removeShare(owner, game.id, share.id).expect(204);
    await readGame(recipient, game.id).expect(403);

    // Gone, so removing it again finds nothing.
    await removeShare(owner, game.id, share.id).expect(404);
  });

  // The list and the search read one scope, so each check below runs both. The
  // tables are swept between tests, so a recipient's list is exactly what the
  // test arranged, and a title token narrows the search to the test's games.
  describe('in the list and the search', () => {
    const arrangeTitled = (createdById: string, token: string, label: string) =>
      arrangeGame(createdById, Reach.Private, `Shared ${token} ${label}`);

    it('lists and finds a game shared with the user, and one shared with their household once in effect', async () => {
      const [owner, recipient, reader, stranger] = await Promise.all([
        actors.user(),
        actors.user(),
        actors.user(),
        actors.user(),
      ]);
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: reader, role: SystemRole.HouseholdMember }],
      });
      const token = randomUUID().slice(0, 8);
      const toUser = await arrangeTitled(owner.user.id, token, 'to a user');
      const toHousehold = await arrangeTitled(owner.user.id, token, 'to a household');
      const unshared = await arrangeTitled(owner.user.id, token, 'unshared');

      // Before the shares, none of the owner's Private games is the recipient's.
      expect(await listedIds(recipient, 'the recipient')).toEqual([]);
      expect(await searchedIds(recipient, token, 'the recipient')).toEqual([]);
      expect(await listedIds(reader, 'the household member')).toEqual([]);

      await sharedWith(owner, toUser.id, { userId: recipient.user.id });
      const householdShare = await sharedWith(owner, toHousehold.id, { householdId: household.id });
      expect(householdShare.approvedAt).not.toBeNull();

      // A share to a user shows that user the one game, and a household's
      // share shows it to the household's members only.
      expect(await listedIds(recipient, 'the recipient')).toEqual([toUser.id]);
      expect(await searchedIds(recipient, token, 'the recipient')).toEqual([toUser.id]);
      expect(await listedIds(reader, 'the household member')).toEqual([toHousehold.id]);
      expect(await searchedIds(reader, token, 'the household member')).toEqual([toHousehold.id]);

      // The control: the owner finds all three, and a stranger none, so the
      // two lists above are about the shares and not the token.
      expect(await listedIds(owner, 'the owner')).toEqual([toUser.id, toHousehold.id, unshared.id].sort());
      expect(await searchedIds(owner, token, 'the owner')).toEqual([toUser.id, toHousehold.id, unshared.id].sort());
      expect(await listedIds(stranger, 'a stranger')).toEqual([]);
      expect(await searchedIds(stranger, token, 'a stranger')).toEqual([]);
    });

    it('leaves a household share that waits for approval out of both, until it is approved', async () => {
      const [owner, member, reader] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({
        owner,
        members: [
          { actor: member, role: SystemRole.HouseholdMember },
          { actor: reader, role: SystemRole.HouseholdMember },
        ],
        memberSharePolicy: MemberSharePolicy.NeedsApproval,
      });
      const token = randomUUID().slice(0, 8);
      const waiting = await arrangeTitled(member.user.id, token, 'waiting');
      const inEffect = await arrangeTitled(owner.user.id, token, 'in effect');

      const waitingShare = await sharedWith(member, waiting.id, { householdId: household.id });
      expect(waitingShare.approvedAt).toBeNull();
      // The control: a household owner's share takes effect at once under the
      // same policy, and it is the only one the reader lists and finds.
      expect((await sharedWith(owner, inEffect.id, { householdId: household.id })).approvedAt).not.toBeNull();

      expect(await listedIds(reader, 'the household member')).toEqual([inEffect.id]);
      expect(await searchedIds(reader, token, 'the household member')).toEqual([inEffect.id]);

      await request(baseUrl)
        .post(`/api/households/${household.id}/game-shares/${waitingShare.id}/approve`)
        .set(owner.headers)
        .expect(200);

      expect(await listedIds(reader, 'the household member')).toEqual([waiting.id, inEffect.id].sort());
      expect(await searchedIds(reader, token, 'the household member')).toEqual([waiting.id, inEffect.id].sort());
    });

    it("leaves a soft-deleted household's share out of both, while a share to a user stays in", async () => {
      const [owner, reader] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: reader, role: SystemRole.HouseholdMember }],
      });
      const token = randomUUID().slice(0, 8);
      const toHousehold = await arrangeTitled(owner.user.id, token, 'to a household');
      const toUser = await arrangeTitled(owner.user.id, token, 'to a user');
      await sharedWith(owner, toHousehold.id, { householdId: household.id });
      await sharedWith(owner, toUser.id, { userId: reader.user.id });

      // The control, in time: both shares are in effect, and both games show.
      expect(await listedIds(reader, 'the household member')).toEqual([toHousehold.id, toUser.id].sort());
      expect(await searchedIds(reader, token, 'the household member')).toEqual([toHousehold.id, toUser.id].sort());
      await readGame(reader, toHousehold.id).expect(200);

      await db.client.household.update({ where: { id: household.id }, data: { deletedAt: new Date() } });

      // A restore (#175) would put the share back in effect, so the row stays
      // while the household is deleted. The game it showed is gone from both,
      // and by id, while the share to the user is untouched.
      expect(await db.client.gameShare.count({ where: { gameId: toHousehold.id } })).toBe(1);
      expect(await listedIds(reader, 'the household member')).toEqual([toUser.id]);
      expect(await searchedIds(reader, token, 'the household member')).toEqual([toUser.id]);
      await readGame(reader, toHousehold.id).expect(403);
    });
  });

  describe('to a household', () => {
    it('refuses a household the actor is not in, even for the Owner, and one that is soft-deleted', async () => {
      const [householdOwner, member] = await Promise.all([actors.user(), actors.user()]);
      const serverOwner = await actors.owner();
      const { household } = await actors.householdWithMembers({
        owner: householdOwner,
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
      });

      // The Owner's own game, into a household they have no seat in.
      const ownersGame = await arrangeGame(serverOwner.user.id, Reach.Private);
      expect(refusal(await shareGame(serverOwner, ownersGame.id, { householdId: household.id }))).toEqual({
        status: 404,
        message: expect.stringContaining(household.id),
      });

      // The control: the household's owner shares into it, at once, and its
      // member reads the game through the share.
      const shared = await arrangeGame(householdOwner.user.id, Reach.Private);
      const share = await sharedWith(householdOwner, shared.id, { householdId: household.id });
      expect(share).toMatchObject({ householdId: household.id, userId: null, approvedById: null });
      expect(share.approvedAt).not.toBeNull();
      await readGame(member, shared.id).expect(200);

      await db.client.household.update({ where: { id: household.id }, data: { deletedAt: new Date() } });

      const later = await arrangeGame(householdOwner.user.id, Reach.Private);
      expect(refusal(await shareGame(householdOwner, later.id, { householdId: household.id }))).toEqual({
        status: 404,
        message: expect.stringContaining(household.id),
      });
      expect(await db.client.gameShare.count({ where: { gameId: later.id } })).toBe(0);
    });

    // A restore (#175) would put the share back in effect, so its sharer
    // keeps the say over it while the household is deleted.
    it('lets the sharer remove their share into a soft-deleted household, while a household owner is still refused it', async () => {
      const [householdOwner, member] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({
        owner: householdOwner,
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
      });
      const game = await arrangeGame(member.user.id, Reach.Private);
      const share = await sharedWith(member, game.id, { householdId: household.id });

      // The household owner sees the member's share while the household is
      // live, so their ability is built before the soft delete below, as it
      // is for a request racing one.
      const before = listGameSharesEnvelope(await listShares(householdOwner, game.id).expect(200), 'as its owner');
      expect(before.shares.map((row) => row.id)).toEqual([share.id]);

      await db.client.household.update({ where: { id: household.id }, data: { deletedAt: new Date() } });

      // The control: a household owner's say over someone else's share reads
      // the roster, so it waits on the household lock, which a deleted
      // household doesn't grant.
      expect(refusal(await removeShare(householdOwner, game.id, share.id))).toEqual({
        status: 404,
        message: expect.stringContaining(household.id),
      });
      expect(await db.client.gameShare.count({ where: { id: share.id } })).toBe(1);

      await removeShare(member, game.id, share.id).expect(204);

      const after = listGameSharesEnvelope(await listShares(member, game.id).expect(200), "as the game's owner");
      expect(after.shares).toEqual([]);
      expect(after.total).toBe(0);
    });
  });
});
