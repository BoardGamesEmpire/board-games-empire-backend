import { MemberSharePolicy, Reach, SystemRole } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { gameShareEnvelope, listGameSharesEnvelope } from '../game/game-share-wire';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { createMemberClient } from './household-request';

type Sharer = 'owner' | 'admin' | 'member' | 'guest';
type Outcome = 'takes effect at once' | 'waits for approval' | 'is refused';

const SHARER_LABEL: Readonly<Record<Sharer, string>> = {
  owner: 'a household owner',
  admin: 'a household admin',
  member: 'someone with the member role',
  guest: 'a household guest',
};

/**
 * Which household role shares how, under each member share policy: the table
 * in `libs/api/household/README.md`. Owners and admins always share directly,
 * a guest never shares into the household, and the policy decides for the
 * member role.
 */
const SHARE_TABLE: ReadonlyArray<readonly [MemberSharePolicy, Sharer, Outcome]> = [
  [MemberSharePolicy.Direct, 'owner', 'takes effect at once'],
  [MemberSharePolicy.Direct, 'admin', 'takes effect at once'],
  [MemberSharePolicy.Direct, 'member', 'takes effect at once'],
  [MemberSharePolicy.Direct, 'guest', 'is refused'],
  [MemberSharePolicy.NeedsApproval, 'owner', 'takes effect at once'],
  [MemberSharePolicy.NeedsApproval, 'admin', 'takes effect at once'],
  [MemberSharePolicy.NeedsApproval, 'member', 'waits for approval'],
  [MemberSharePolicy.NeedsApproval, 'guest', 'is refused'],
  [MemberSharePolicy.Off, 'owner', 'takes effect at once'],
  [MemberSharePolicy.Off, 'admin', 'takes effect at once'],
  [MemberSharePolicy.Off, 'member', 'is refused'],
  [MemberSharePolicy.Off, 'guest', 'is refused'],
];

/**
 * Game shares from the household's side (#810), against real rows: every cell
 * of the member share policy table through the real routes, approving a
 * member's waiting share, removing a share as one of the household's owners
 * or admins, and the household's own list of its shares.
 *
 * - `POST /api/games/:id/shares` with `{ householdId }` shares a game into the
 *   household, at once or for approval, as the sharer's household role and
 *   the member share policy say.
 * - `POST /api/households/:householdId/game-shares/:shareId/approve` puts a
 *   waiting share in effect.
 * - `GET /api/households/:householdId/game-shares` lists the household's
 *   shares, waiting ones included, to its owners and admins.
 * - `DELETE /api/games/:id/shares/:shareId` removes one.
 * - `DELETE /api/households/:id/members/me` and `DELETE …/members/:memberId`
 *   take a member's shares into the household with them.
 *
 * A game that exists and that the caller may not read answers 403 at
 * `GET /games/:id`, as `game-authorization.spec.ts` pins, so that is what a
 * share that grants nothing leaves its household with.
 *
 * Actors and rosters are arranged before any of them sends a request: the API
 * caches each user's ability on first use and this process cannot evict it
 * (#256). Every denial below is paired with a control on the same route or the
 * same row.
 */
describe('household game shares', () => {
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

  const { removeMember, leave, changeRole } = createMemberClient(baseUrl);

  const readGame = (actor: SessionActor, id: string) => request(baseUrl).get(`${GAMES_PATH}/${id}`).set(actor.headers);

  const shareGame = (actor: SessionActor, gameId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(`${GAMES_PATH}/${gameId}/shares`).set(actor.headers).send(body);

  const removeShare = (actor: SessionActor, gameId: string, shareId: string) =>
    request(baseUrl).delete(`${GAMES_PATH}/${gameId}/shares/${shareId}`).set(actor.headers);

  const approve = (actor: SessionActor, householdId: string, shareId: string) =>
    request(baseUrl).post(`/api/households/${householdId}/game-shares/${shareId}/approve`).set(actor.headers);

  const listHouseholdShares = (actor: SessionActor, householdId: string) =>
    request(baseUrl).get(`/api/households/${householdId}/game-shares`).set(actor.headers);

  const patchSettings = (actor: SessionActor, householdId: string, settings: Record<string, unknown>) =>
    request(baseUrl).patch(`/api/households/${householdId}`).set(actor.headers).send({ settings });

  /** The share a 201 hands back, parsed. */
  const sharedInto = async (actor: SessionActor, gameId: string, householdId: string) =>
    gameShareEnvelope(await shareGame(actor, gameId, { householdId }).expect(201), 'POST /api/games/:id/shares').share;

  /** The share an approval's 200 hands back, parsed. */
  const approved = async (actor: SessionActor, householdId: string, shareId: string) =>
    gameShareEnvelope(
      await approve(actor, householdId, shareId).expect(200),
      'POST /api/households/:householdId/game-shares/:shareId/approve',
    ).share;

  /** A refusal's status and message, so a 404 can be told apart by the id it names. */
  const refusal = (response: { status: number; body: unknown }) => ({
    status: response.status,
    message: (response.body as { message?: unknown } | null)?.message ?? null,
  });

  const arrangeGame = (createdById: string) =>
    db.client.game.create({
      data: { title: `e2e game ${randomUUID().slice(0, 8)}`, reach: Reach.Private, createdById },
      select: { id: true, title: true, thumbnail: true },
    });

  const storedShare = (id: string) =>
    db.client.gameShare.findUnique({ where: { id }, select: { approvedAt: true, approvedById: true } });

  const softDelete = (householdId: string) =>
    db.client.household.update({ where: { id: householdId }, data: { deletedAt: new Date() } });

  /**
   * A household with an owner, an admin, two people with the member role and
   * a guest, under `memberSharePolicy`, and an outsider who is in none of it.
   * The member shares; the reader is the household's other member, who reads
   * what the shares grant.
   */
  const household = async (memberSharePolicy?: MemberSharePolicy) => {
    const [owner, admin, member, reader, guest, outsider] = await Promise.all(
      Array.from({ length: 6 }, () => actors.user()),
    );
    const { household: created, members } = await actors.householdWithMembers({
      owner,
      members: [
        { actor: admin, role: SystemRole.HouseholdAdmin },
        { actor: member, role: SystemRole.HouseholdMember },
        { actor: reader, role: SystemRole.HouseholdMember },
        { actor: guest, role: SystemRole.HouseholdGuest },
      ],
      memberSharePolicy,
    });

    return {
      householdId: created.id,
      owner,
      admin,
      member,
      reader,
      guest,
      outsider,
      memberMemberId: members[1].member.id,
    };
  };

  describe('the member share policy table', () => {
    it.each(SHARE_TABLE.map(([policy, sharer, outcome]) => [policy, SHARER_LABEL[sharer], outcome, sharer] as const))(
      'under %s, a share by %s %s',
      async (policy, _label, outcome, sharer) => {
        const roster = await household(policy);
        const actor = roster[sharer];
        const game = await arrangeGame(actor.user.id);

        const response = await shareGame(actor, game.id, { householdId: roster.householdId });

        if (outcome === 'is refused') {
          expect(refusal(response)).toEqual({ status: 403, message: expect.any(String) });
          expect(await db.client.gameShare.count({ where: { gameId: game.id } })).toBe(0);
          await readGame(roster.reader, game.id).expect(403);

          // The control: the household owner's share into the same household
          // takes effect, so the refusal is about the sharer's household role.
          const ownersGame = await arrangeGame(roster.owner.user.id);
          const control = await sharedInto(roster.owner, ownersGame.id, roster.householdId);
          expect(control.approvedAt).not.toBeNull();
          await readGame(roster.reader, ownersGame.id).expect(200);

          return;
        }

        expect(response.status).toBe(201);
        const share = gameShareEnvelope(response, 'POST /api/games/:id/shares').share;
        expect(share).toMatchObject({
          gameId: game.id,
          householdId: roster.householdId,
          userId: null,
          sharedById: actor.user.id,
          approvedById: null,
        });

        if (outcome === 'waits for approval') {
          expect(share.approvedAt).toBeNull();
          await readGame(roster.reader, game.id).expect(403);
        } else {
          expect(share.approvedAt).not.toBeNull();
          await readGame(roster.reader, game.id).expect(200);
        }
      },
    );
  });

  it('lets a waiting share grant nothing until an owner or admin approves it', async () => {
    const { householdId, admin, member, reader } = await household(MemberSharePolicy.NeedsApproval);
    const game = await arrangeGame(member.user.id);

    const share = await sharedInto(member, game.id, householdId);
    expect(share.approvedAt).toBeNull();

    await readGame(reader, game.id).expect(403);

    const after = await approved(admin, householdId, share.id);

    expect(after).toMatchObject({ id: share.id, householdId, sharedById: member.user.id, approvedById: admin.user.id });
    expect(after.approvedAt).not.toBeNull();
    await expect(storedShare(share.id)).resolves.toEqual({
      approvedAt: new Date(after.approvedAt as string),
      approvedById: admin.user.id,
    });

    await readGame(reader, game.id).expect(200);
  });

  /** Whether a refusal is the one for a share its sharer could no longer make. */
  const sharerCannotShare = (response: { body: unknown }) =>
    expect((response.body as { message?: unknown }).message).toContain('can no longer share');

  it('keeps a waiting share approvable after a policy change only while its sharer could still share it', async () => {
    const { householdId, owner, member, reader } = await household(MemberSharePolicy.NeedsApproval);
    const [game, later] = await Promise.all([arrangeGame(member.user.id), arrangeGame(member.user.id)]);
    const share = await sharedInto(member, game.id, householdId);

    await patchSettings(owner, householdId, { memberSharePolicy: MemberSharePolicy.Off }).expect(200);

    // The switch has landed: the member can no longer share at all.
    await shareGame(member, later.id, { householdId }).expect(403);

    // Under Off the member could share it neither way, as an invite's sender
    // under Off could send it neither way (#747). The approval is refused, and
    // the share waits on, granting nothing.
    sharerCannotShare(await approve(owner, householdId, share.id).expect(409));
    await expect(storedShare(share.id)).resolves.toEqual({ approvedAt: null, approvedById: null });
    await readGame(reader, game.id).expect(403);

    // Under Direct the member could share it in effect, so it is approvable.
    await patchSettings(owner, householdId, { memberSharePolicy: MemberSharePolicy.Direct }).expect(200);
    const after = await approved(owner, householdId, share.id);

    expect(after).toMatchObject({ id: share.id, approvedById: owner.user.id });
    expect(after.approvedAt).not.toBeNull();
    await readGame(reader, game.id).expect(200);
  });

  it('refuses to approve a waiting share whose sharer has been made a guest since', async () => {
    const { householdId, owner, admin, member, reader, memberMemberId } = await household(
      MemberSharePolicy.NeedsApproval,
    );
    const [game, readersGame] = await Promise.all([arrangeGame(member.user.id), arrangeGame(reader.user.id)]);
    const share = await sharedInto(member, game.id, householdId);
    const control = await sharedInto(reader, readersGame.id, householdId);

    await changeRole(owner, householdId, memberMemberId, SystemRole.HouseholdGuest).expect(200);

    // A guest never shares into the household, so the approval is refused.
    sharerCannotShare(await approve(admin, householdId, share.id).expect(409));
    await expect(storedShare(share.id)).resolves.toEqual({ approvedAt: null, approvedById: null });
    await readGame(reader, game.id).expect(403);

    // The control: a waiting share by someone still with the member role is
    // approved by the same admin.
    await approved(admin, householdId, control.id);
    await readGame(member, readersGame.id).expect(200);
  });

  it('refuses approval to the member role and to a guest', async () => {
    const { householdId, admin, member, reader, guest } = await household(MemberSharePolicy.NeedsApproval);
    const game = await arrangeGame(member.user.id);
    const share = await sharedInto(member, game.id, householdId);

    // The sharer is refused too: their own share is not theirs to approve.
    for (const actor of [member, reader, guest]) {
      expect(refusal(await approve(actor, householdId, share.id))).toEqual({
        status: 403,
        message: expect.any(String),
      });
    }

    await expect(storedShare(share.id)).resolves.toEqual({ approvedAt: null, approvedById: null });
    await readGame(reader, game.id).expect(403);

    // The control: the household admin approves the same share.
    await approved(admin, householdId, share.id);
    await readGame(reader, game.id).expect(200);
  });

  it('answers 409 for approving a share already in effect, and 404 for one its sharer removed', async () => {
    const { householdId, owner, admin, member } = await household(MemberSharePolicy.NeedsApproval);
    const [waiting, removed] = await Promise.all([arrangeGame(member.user.id), arrangeGame(member.user.id)]);
    const direct = await arrangeGame(owner.user.id);

    // The control: the first approval of a waiting share succeeds.
    const share = await sharedInto(member, waiting.id, householdId);
    const first = await approved(admin, householdId, share.id);

    // A second approval writes nothing: the share keeps the first's approver and time.
    expect(refusal(await approve(owner, householdId, share.id))).toEqual({
      status: 409,
      message: expect.stringContaining(share.id),
    });
    await expect(storedShare(share.id)).resolves.toEqual({
      approvedAt: new Date(first.approvedAt as string),
      approvedById: admin.user.id,
    });

    // A share made directly was never waiting, and has no approver to gain.
    const directShare = await sharedInto(owner, direct.id, householdId);
    expect(refusal(await approve(admin, householdId, directShare.id))).toEqual({
      status: 409,
      message: expect.stringContaining(directShare.id),
    });
    await expect(storedShare(directShare.id)).resolves.toEqual({
      approvedAt: new Date(directShare.approvedAt as string),
      approvedById: null,
    });

    const gone = await sharedInto(member, removed.id, householdId);
    await removeShare(member, removed.id, gone.id).expect(204);

    expect(refusal(await approve(admin, householdId, gone.id))).toEqual({
      status: 404,
      message: expect.stringContaining(gone.id),
    });
    expect(await db.client.gameShare.count({ where: { id: gone.id } })).toBe(0);
  });

  it("answers 404 for a share into another household, through this household's route", async () => {
    const here = await household(MemberSharePolicy.NeedsApproval);
    const there = await household(MemberSharePolicy.NeedsApproval);
    const game = await arrangeGame(there.member.user.id);
    const share = await sharedInto(there.member, game.id, there.householdId);

    // This household's admin may approve here, and the share is not here.
    expect(refusal(await approve(here.admin, here.householdId, share.id))).toEqual({
      status: 404,
      message: expect.stringContaining(share.id),
    });
    // Through the other household's route, this admin has no say.
    await approve(here.admin, there.householdId, share.id).expect(403);
    await expect(storedShare(share.id)).resolves.toEqual({ approvedAt: null, approvedById: null });

    // The control: the other household's admin approves it there.
    await approved(there.admin, there.householdId, share.id);
  });

  it('refuses a share into a household the owner does not belong to', async () => {
    const { householdId, member, reader, outsider } = await household(MemberSharePolicy.Direct);
    const game = await arrangeGame(outsider.user.id);

    expect(refusal(await shareGame(outsider, game.id, { householdId }))).toEqual({
      status: 404,
      message: expect.stringContaining(householdId),
    });
    expect(await db.client.gameShare.count({ where: { gameId: game.id } })).toBe(0);
    await readGame(reader, game.id).expect(403);

    // The control: a member of the household shares a game of theirs into it.
    const membersGame = await arrangeGame(member.user.id);
    await sharedInto(member, membersGame.id, householdId);
    await readGame(reader, membersGame.id).expect(200);
  });

  it('refuses a share into a soft-deleted household', async () => {
    const { householdId, owner, reader } = await household(MemberSharePolicy.Direct);
    const [before, after] = await Promise.all([arrangeGame(owner.user.id), arrangeGame(owner.user.id)]);

    // The control: while the household is live, its owner shares into it.
    await sharedInto(owner, before.id, householdId);
    await readGame(reader, before.id).expect(200);

    await softDelete(householdId);

    expect(refusal(await shareGame(owner, after.id, { householdId }))).toEqual({
      status: 404,
      message: expect.stringContaining(householdId),
    });
    expect(await db.client.gameShare.count({ where: { gameId: after.id } })).toBe(0);

    // The share made before the delete stops showing the game too.
    await readGame(reader, before.id).expect(403);
  });

  it('lets an owner or admin of the recipient household remove a share', async () => {
    const { householdId, owner, admin, member, reader } = await household(MemberSharePolicy.Direct);
    const [first, second] = await Promise.all([arrangeGame(member.user.id), arrangeGame(member.user.id)]);
    const firstShare = await sharedInto(member, first.id, householdId);
    const secondShare = await sharedInto(member, second.id, householdId);

    await readGame(reader, first.id).expect(200);

    // Another member has no say over someone else's share, and it stands.
    await removeShare(reader, first.id, firstShare.id).expect(403);
    await readGame(reader, first.id).expect(200);

    await removeShare(owner, first.id, firstShare.id).expect(204);
    await removeShare(admin, second.id, secondShare.id).expect(204);

    await readGame(reader, first.id).expect(403);
    await readGame(reader, second.id).expect(403);
    expect(await db.client.gameShare.count({ where: { gameId: { in: [first.id, second.id] } } })).toBe(0);
  });

  it("lists the household's shares, waiting ones included, to its owners and admins only", async () => {
    const { householdId, owner, admin, member, guest } = await household(MemberSharePolicy.NeedsApproval);
    // A second household of the same owner, arranged before any request, whose
    // share must not show in this household's list.
    const { household: elsewhere } = await actors.householdWithMembers({ owner });
    const [ownersGame, membersGame, elsewhereGame] = await Promise.all([
      arrangeGame(owner.user.id),
      arrangeGame(member.user.id),
      arrangeGame(owner.user.id),
    ]);

    const direct = await sharedInto(owner, ownersGame.id, householdId);
    const waiting = await sharedInto(member, membersGame.id, householdId);
    await sharedInto(owner, elsewhereGame.id, elsewhere.id);

    for (const [who, actor] of [
      ['its owner', owner],
      ['its admin', admin],
    ] as const) {
      const page = listGameSharesEnvelope(
        await listHouseholdShares(actor, householdId).expect(200),
        `GET /api/households/:householdId/game-shares as ${who}`,
      );

      expect(page.total).toBe(2);
      expect(page.shares).toHaveLength(2);
      // Each row names its game, so an approver can tell what they approve.
      expect(page.shares).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: direct.id, approvedAt: direct.approvedAt, game: ownersGame }),
          expect.objectContaining({ id: waiting.id, approvedAt: null, game: membersGame }),
        ]),
      );
    }

    // The member's waiting share is their own, and the list is still not theirs.
    for (const actor of [member, guest]) {
      expect(refusal(await listHouseholdShares(actor, householdId))).toEqual({
        status: 403,
        message: expect.any(String),
      });
    }
  });

  it('answers 404 for the list and the approve once the household is soft-deleted', async () => {
    const { householdId, owner, admin, member } = await household(MemberSharePolicy.NeedsApproval);
    const game = await arrangeGame(member.user.id);
    const share = await sharedInto(member, game.id, householdId);

    // The control: while the household is live, its owner lists the share.
    const page = listGameSharesEnvelope(
      await listHouseholdShares(owner, householdId).expect(200),
      'GET /api/households/:householdId/game-shares',
    );
    expect(page.shares.map((row) => row.id)).toEqual([share.id]);

    await softDelete(householdId);

    expect(refusal(await listHouseholdShares(owner, householdId))).toEqual({
      status: 404,
      message: expect.stringContaining(householdId),
    });
    expect(refusal(await approve(admin, householdId, share.id))).toEqual({
      status: 404,
      message: expect.stringContaining(householdId),
    });
    await expect(storedShare(share.id)).resolves.toEqual({ approvedAt: null, approvedById: null });
  });

  describe('when a member leaves or is removed', () => {
    /** How the member departs: they leave, or a household owner removes them. */
    const DEPARTURES = [
      ['leave', (h: Awaited<ReturnType<typeof household>>) => leave(h.member, h.householdId)],
      [
        'are removed',
        (h: Awaited<ReturnType<typeof household>>) => removeMember(h.owner, h.householdId, h.memberMemberId),
      ],
    ] as const;

    it.each(DEPARTURES)("ends a member's game shares into the household when they %s", async (_how, depart) => {
      const h = await household(MemberSharePolicy.NeedsApproval);
      // The departing member belongs to a second household too, arranged
      // before any request.
      const [elsewhereOwner, elsewhereReader] = await Promise.all([actors.user(), actors.user()]);
      const { household: elsewhere } = await actors.householdWithMembers({
        owner: elsewhereOwner,
        members: [
          { actor: h.member, role: SystemRole.HouseholdMember },
          { actor: elsewhereReader, role: SystemRole.HouseholdMember },
        ],
        memberSharePolicy: MemberSharePolicy.Direct,
      });
      const [inBoth, waiting, orphaned, readers] = await Promise.all([
        arrangeGame(h.member.user.id),
        arrangeGame(h.member.user.id),
        arrangeGame(h.member.user.id),
        arrangeGame(h.reader.user.id),
      ]);

      // The departing member's share in effect here and in the other household,
      // one still waiting for approval here, and another member's share in
      // effect here.
      const inBothShare = await approved(
        h.admin,
        h.householdId,
        (await sharedInto(h.member, inBoth.id, h.householdId)).id,
      );
      const inBothElsewhere = await sharedInto(h.member, inBoth.id, elsewhere.id);
      const waitingShare = await sharedInto(h.member, waiting.id, h.householdId);
      const readersShare = await approved(
        h.admin,
        h.householdId,
        (await sharedInto(h.reader, readers.id, h.householdId)).id,
      );
      // A share whose `sharedById` an account deletion emptied (`SetNull`) is
      // still the departing member's, since the game is.
      const orphanedShare = await db.client.gameShare.create({
        data: { gameId: orphaned.id, householdId: h.householdId, approvedAt: new Date() },
        select: { id: true },
      });

      const householdShareIds = async () =>
        listGameSharesEnvelope(
          await listHouseholdShares(h.owner, h.householdId).expect(200),
          'GET /api/households/:householdId/game-shares',
        )
          .shares.map((row) => row.id)
          .sort();

      // The controls first: before the departure the household's owner lists all
      // four, and its other members read the three that are in effect.
      expect(await householdShareIds()).toEqual(
        [inBothShare.id, waitingShare.id, orphanedShare.id, readersShare.id].sort(),
      );
      await readGame(h.admin, inBoth.id).expect(200);
      await readGame(h.admin, orphaned.id).expect(200);
      await readGame(h.admin, readers.id).expect(200);
      await readGame(h.admin, waiting.id).expect(403);
      await readGame(elsewhereReader, inBoth.id).expect(200);

      await depart(h).expect(200);

      // Gone from the household: the list no longer has the departing member's
      // rows, the waiting one included, and the household's other members no
      // longer reach the games that were in effect.
      expect(await householdShareIds()).toEqual([readersShare.id]);
      expect(
        await db.client.gameShare.count({
          where: { householdId: h.householdId, game: { createdById: h.member.user.id } },
        }),
      ).toBe(0);
      await readGame(h.admin, inBoth.id).expect(403);
      await readGame(h.admin, orphaned.id).expect(403);

      // Another member's share into the household stays.
      await readGame(h.admin, readers.id).expect(200);
      await readGame(h.guest, readers.id).expect(200);

      // The departing member's share into their other household stays, and the
      // game is theirs still.
      await expect(storedShare(inBothElsewhere.id)).resolves.not.toBeNull();
      await readGame(elsewhereReader, inBoth.id).expect(200);
      await readGame(h.member, inBoth.id).expect(200);
    });
  });
});
