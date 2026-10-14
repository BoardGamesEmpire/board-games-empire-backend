import { FriendshipStatus, Visibility } from '@bge/database';
import { befriend, createActors, type Actors, type AuthenticatedActor, type SessionActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { inviteEnvelope, inviteListEnvelope } from './household-invite-wire';

/** The server policy's refusal, by id or by address. */
const FRIENDS_ONLY =
  'This server only allows household invites to your friends, invited from their account rather than by email address';

/** A block's or a preference's refusal by id: one message, so the inviter cannot tell which. */
const REFUSED = 'You cannot invite this user to a household';

/**
 * Who may be invited to a household (#278): the server's policy, a block
 * between the two, and the invitee's own preference, checked in that order.
 *
 * By id, each refuses with 403. By address, the server's policy refuses every
 * address under `Friends`, and a block or a preference refuses nothing: the
 * invite is stored withheld and answers like any other, so the answer never
 * depends on who holds the address.
 *
 * The settings row is on the isolation sweep's preserved list, so each test
 * puts the policy back. The defaults, `Public` and no preference row, are what
 * `household-invites.spec.ts` runs under.
 */
describe('household invite gating', () => {
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

  const readPolicy = async () =>
    (await db.client.systemSetting.findUniqueOrThrow({ where: { singleton: true } })).householdInviteePolicy;

  const setPolicy = (householdInviteePolicy: Visibility) =>
    db.client.systemSetting.update({ where: { singleton: true }, data: { householdInviteePolicy } });

  let originalPolicy: Visibility;

  beforeEach(async () => {
    originalPolicy = await readPolicy();
  });

  afterEach(async () => {
    await setPolicy(originalPolicy);
  });

  const invitesPath = (householdId: string) => `/api/households/${householdId}/invites`;

  const createInvite = (actor: AuthenticatedActor, householdId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(invitesPath(householdId)).set(actor.headers).send(body);

  const createdInvite = async (actor: AuthenticatedActor, householdId: string, body: Record<string, unknown>) =>
    inviteEnvelope(await createInvite(actor, householdId, body).expect(201), 'POST /api/households/:id/invites').invite;

  /** The message a refusal answers with, once its status is checked. */
  const refusal = async (actor: AuthenticatedActor, householdId: string, body: Record<string, unknown>) =>
    (await createInvite(actor, householdId, body).expect(403)).body.message as string;

  const withheld = async (id: string) =>
    (await db.client.invite.findUniqueOrThrow({ where: { id }, select: { withheld: true } })).withheld;

  /**
   * A block, written as the friendship service leaves one: the blocker is the
   * row's requester, whichever of the two asked first.
   */
  const block = (blocker: SessionActor, blocked: SessionActor) =>
    db.client.friendship.create({
      data: {
        requesterId: blocker.user.id,
        addresseeId: blocked.user.id,
        pairKey: [blocker.user.id, blocked.user.id].sort().join(':'),
        status: FriendshipStatus.Blocked,
        respondedAt: new Date(),
      },
    });

  /** No route writes a preference yet (#725), so it is written here. */
  const prefer = (actor: SessionActor, allowHouseholdInvitesFrom: Visibility) =>
    db.client.userPreferences.upsert({
      where: { userId: actor.user.id },
      create: { userId: actor.user.id, allowHouseholdInvitesFrom },
      update: { allowHouseholdInvitesFrom },
    });

  describe('a block', () => {
    it('refuses a blocked pair by id whichever of the two blocked, in the words a preference uses', async () => {
      const [owner, blocker, blocked, closed] = await Promise.all(Array.from({ length: 4 }, () => actors.user()));
      const { household } = await actors.householdWithMembers({ owner });
      await block(blocker, owner);
      await block(owner, blocked);
      await prefer(closed, Visibility.Private);

      const messages = [
        await refusal(owner, household.id, { inviteeId: blocker.user.id }),
        await refusal(owner, household.id, { inviteeId: blocked.user.id }),
        await refusal(owner, household.id, { inviteeId: closed.user.id }),
      ];

      expect(messages).toEqual([REFUSED, REFUSED, REFUSED]);
      expect(await db.client.invite.count({ where: { householdId: household.id } })).toBe(0);
    });

    it('withholds an invite to a blocked pair’s address, and answers and lists it like any other', async () => {
      const [owner, blocker, blocked, open] = await Promise.all(Array.from({ length: 4 }, () => actors.user()));
      const { household } = await actors.householdWithMembers({ owner });
      await block(blocker, owner);
      await block(owner, blocked);
      // A block counts from an account that never proved its address: the
      // check only denies, so it needs no proof.
      await expect(
        db.client.user.findUniqueOrThrow({ where: { id: blocker.user.id }, select: { emailVerified: true } }),
      ).resolves.toEqual({ emailVerified: false });

      const toBlocker = await createdInvite(owner, household.id, { inviteeEmail: blocker.user.email });
      const toBlocked = await createdInvite(owner, household.id, { inviteeEmail: blocked.user.email });
      const toOpen = await createdInvite(owner, household.id, { inviteeEmail: open.user.email });

      expect([await withheld(toBlocker.id), await withheld(toBlocked.id), await withheld(toOpen.id)]).toEqual([
        true,
        true,
        false,
      ]);

      for (const invite of [toBlocker, toBlocked]) {
        expect(Object.keys(invite).sort()).toEqual(Object.keys(toOpen).sort());
        expect(invite).toMatchObject({ status: toOpen.status, inviteeName: null });
      }
      expect(toOpen).not.toHaveProperty('withheld');

      const listed = inviteListEnvelope(
        await request(baseUrl).get(invitesPath(household.id)).set(owner.headers).expect(200),
        'GET /api/households/:id/invites',
      ).invites;
      expect(listed.map((invite) => invite.id).sort()).toEqual([toBlocker.id, toBlocked.id, toOpen.id].sort());
      for (const row of listed) {
        expect(Object.keys(row).sort()).toEqual(Object.keys(toOpen).sort());
      }
    });
  });

  describe('the server policy', () => {
    it('under Friends, lets a friend in by id and refuses a non-friend by id and every address alike', async () => {
      const [owner, friend, stranger] = await Promise.all(Array.from({ length: 3 }, () => actors.user()));
      const { household } = await actors.householdWithMembers({ owner });
      await befriend(db.client, owner, friend);
      await setPolicy(Visibility.Friends);

      await createdInvite(owner, household.id, { inviteeId: friend.user.id });

      // A friend's address is refused as any other is, so a refusal tells the
      // inviter nothing about whose address it is.
      const messages = [
        await refusal(owner, household.id, { inviteeId: stranger.user.id }),
        await refusal(owner, household.id, { inviteeEmail: friend.user.email }),
        await refusal(owner, household.id, { inviteeEmail: stranger.user.email }),
        await refusal(owner, household.id, { inviteeEmail: `nobody-${randomUUID()}@e2e.invalid` }),
      ];

      expect(messages).toEqual([FRIENDS_ONLY, FRIENDS_ONLY, FRIENDS_ONLY, FRIENDS_ONLY]);
      expect(await db.client.invite.count({ where: { householdId: household.id } })).toBe(1);
    });

    it('under Public, lets in a non-friend by id and by address', async () => {
      const [owner, stranger] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner });
      await setPolicy(Visibility.Public);

      await createdInvite(owner, household.id, { inviteeId: stranger.user.id });
      const byAddress = await createdInvite(owner, household.id, { inviteeEmail: stranger.user.email });

      expect(await withheld(byAddress.id)).toBe(false);
    });
  });

  describe('the invitee’s preference', () => {
    it('is honoured when stricter than the server’s: by id it refuses, by address it withholds', async () => {
      const [owner, friendsOnly, friend, closedFriend] = await Promise.all(
        Array.from({ length: 4 }, () => actors.user()),
      );
      const { household } = await actors.householdWithMembers({ owner });
      await befriend(db.client, owner, friend);
      await befriend(db.client, owner, closedFriend);
      await prefer(friendsOnly, Visibility.Friends);
      await prefer(friend, Visibility.Friends);
      await prefer(closedFriend, Visibility.Private);
      await setPolicy(Visibility.Public);

      await createdInvite(owner, household.id, { inviteeId: friend.user.id });
      expect(await refusal(owner, household.id, { inviteeId: friendsOnly.user.id })).toBe(REFUSED);
      expect(await refusal(owner, household.id, { inviteeId: closedFriend.user.id })).toBe(REFUSED);

      const toFriendsOnly = await createdInvite(owner, household.id, { inviteeEmail: friendsOnly.user.email });
      const toClosedFriend = await createdInvite(owner, household.id, { inviteeEmail: closedFriend.user.email });
      const toFriend = await createdInvite(owner, household.id, { inviteeEmail: friend.user.email });

      expect([
        await withheld(toFriendsOnly.id),
        await withheld(toClosedFriend.id),
        await withheld(toFriend.id),
      ]).toEqual([true, true, false]);
    });

    it('does not widen the server’s policy when looser, which refuses in its own words', async () => {
      const [owner, stranger] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner });
      await prefer(stranger, Visibility.Public);
      await setPolicy(Visibility.Friends);

      expect(await refusal(owner, household.id, { inviteeId: stranger.user.id })).toBe(FRIENDS_ONLY);
    });
  });
});
