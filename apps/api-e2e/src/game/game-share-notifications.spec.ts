import { MemberSharePolicy, NotificationType, Reach, SystemRole } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { UnreadNotificationWire } from '../notification/notification-wire';
import { unreadWhen } from '../notification/unread-poll';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { gameShareEnvelope } from './game-share-wire';

type Unread = readonly UnreadNotificationWire[];

/**
 * The game share notifications, driven over HTTP and read back through
 * `GET /api/notifications/unread` (#810):
 *
 * - a share naming a user tells that user, who is the one it takes effect for,
 *   and it takes effect on create;
 * - a household share that waits for approval tells the household's owners and
 *   admins, and no one else in the household;
 * - a household share that takes effect tells nobody: its household's members
 *   find it among the games they can read.
 *
 * The listener runs after the response to the request that caused it, so each
 * test polls for what it expects. Where a user must NOT be told, the test sends
 * them a later notification and waits for that one before checking: a fixed
 * sleep would pass as well if the listener never ran. Each such check sits in
 * a test whose other half is the flow that does tell someone.
 *
 * Actors and rosters are arranged before any of them sends a request, as in
 * `household-game-shares.spec.ts`: the API caches each user's ability on first
 * use and this process cannot evict it (#256).
 */
describe('game share notifications', () => {
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

  const arrangeGame = (createdById: string) =>
    db.client.game.create({
      data: { title: `e2e game ${randomUUID().slice(0, 8)}`, reach: Reach.Private, createdById },
      select: { id: true, title: true },
    });

  /** The share a 201 hands back, parsed. */
  const sharedWith = async (actor: SessionActor, gameId: string, body: Record<string, unknown>) =>
    gameShareEnvelope(
      await request(baseUrl).post(`/api/games/${gameId}/shares`).set(actor.headers).send(body).expect(201),
      'POST /api/games/:id/shares',
    ).share;

  /** A user's display name, or their username when it is unset or blank: how a notification names them. */
  const nameOf = async (actor: SessionActor) => {
    const profile = await db.client.userProfile.findUnique({ where: { userId: actor.user.id } });

    return profile?.displayName || actor.user.username;
  };

  const unread = (actor: SessionActor, predicate: (unread: Unread) => boolean) => unreadWhen(baseUrl, actor, predicate);

  /** The notifications of one type, about one share. */
  const about = (list: Unread, type: NotificationType, shareId: string) =>
    list.filter((notification) => notification.type === type && notification.payload['shareId'] === shareId);

  const holds = (type: NotificationType, shareId: string) => (list: Unread) => about(list, type, shareId).length > 0;

  /**
   * A household with an owner, an admin, two people with the member role and a
   * guest, under `memberSharePolicy`. The member shares; the reader is the
   * household's other member.
   */
  const household = async (memberSharePolicy: MemberSharePolicy) => {
    const [owner, admin, member, reader, guest] = await Promise.all(Array.from({ length: 5 }, () => actors.user()));
    const { household: created } = await actors.householdWithMembers({
      owner,
      members: [
        { actor: admin, role: SystemRole.HouseholdAdmin },
        { actor: member, role: SystemRole.HouseholdMember },
        { actor: reader, role: SystemRole.HouseholdMember },
        { actor: guest, role: SystemRole.HouseholdGuest },
      ],
      memberSharePolicy,
    });

    return { household: created, owner, admin, member, reader, guest };
  };

  describe('a share to a user', () => {
    it('tells the user a game was shared with them, and never tells the sharer (#810)', async () => {
      const [owner, recipient] = await Promise.all([actors.user(), actors.user()]);
      const game = await arrangeGame(owner.user.id);
      const gameBack = await arrangeGame(recipient.user.id);

      const share = await sharedWith(owner, game.id, { userId: recipient.user.id });

      const told = await unread(recipient, holds(NotificationType.GameShareReceived, share.id));

      // Exactly these keys: the game, who shared it and the share to act on.
      expect(about(told, NotificationType.GameShareReceived, share.id)).toEqual([
        expect.objectContaining({
          payload: {
            shareId: share.id,
            gameId: game.id,
            gameTitle: game.title,
            sharerName: await nameOf(owner),
          },
        }),
      ]);

      // The recipient's share back tells the owner, and is the notification
      // waited for: the owner was told nothing of the share they made.
      const shareBack = await sharedWith(recipient, gameBack.id, { userId: owner.user.id });
      const sharerList = await unread(owner, holds(NotificationType.GameShareReceived, shareBack.id));

      expect(sharerList.map((notification) => notification.payload['shareId'])).toEqual([shareBack.id]);
      expect(about(sharerList, NotificationType.GameShareReceived, share.id)).toEqual([]);
    });
  });

  describe('a share to a household', () => {
    it('tells the household owners and admins that a member share awaits approval, and no one else (#810)', async () => {
      const {
        household: created,
        owner,
        admin,
        member,
        reader,
        guest,
      } = await household(MemberSharePolicy.NeedsApproval);
      const game = await arrangeGame(member.user.id);
      const sentinelGame = await arrangeGame(owner.user.id);

      const share = await sharedWith(member, game.id, { householdId: created.id });

      expect(share.approvedAt).toBeNull();

      for (const approver of [owner, admin]) {
        const waiting = await unread(approver, holds(NotificationType.GameShareAwaitingApproval, share.id));

        expect(about(waiting, NotificationType.GameShareAwaitingApproval, share.id)).toEqual([
          expect.objectContaining({
            payload: {
              householdId: created.id,
              householdName: created.name,
              shareId: share.id,
              gameId: game.id,
              gameTitle: game.title,
              sharerName: await nameOf(member),
            },
          }),
        ]);
      }

      // A share to each of the others by name tells them, and is the
      // notification waited for: nothing reached them about the one that waits.
      for (const bystander of [member, reader, guest]) {
        const byName = await sharedWith(owner, sentinelGame.id, { userId: bystander.user.id });
        const told = await unread(bystander, holds(NotificationType.GameShareReceived, byName.id));

        expect(told.map((notification) => notification.type)).toEqual([NotificationType.GameShareReceived]);
      }
    });

    it('tells no one of a household share that takes effect, and tells the owners when the same member must wait (#810)', async () => {
      const { household: created, owner, admin, member, reader } = await household(MemberSharePolicy.Direct);
      const [byMember, byOwner, whileWaiting, sentinelGame] = await Promise.all([
        arrangeGame(member.user.id),
        arrangeGame(owner.user.id),
        arrangeGame(member.user.id),
        arrangeGame(owner.user.id),
      ]);

      // Under Direct a member's share takes effect, and so does an owner's.
      const direct = await sharedWith(member, byMember.id, { householdId: created.id });
      const ownersShare = await sharedWith(owner, byOwner.id, { householdId: created.id });

      expect(direct.approvedAt).not.toBeNull();
      expect(ownersShare.approvedAt).not.toBeNull();

      // The control: with the policy flipped, the same member's share waits,
      // and it is the owner and admin it tells.
      await db.client.householdSettings.update({
        where: { householdId: created.id },
        data: { memberSharePolicy: MemberSharePolicy.NeedsApproval },
      });
      const waiting = await sharedWith(member, whileWaiting.id, { householdId: created.id });

      expect(waiting.approvedAt).toBeNull();

      for (const approver of [owner, admin]) {
        const told = await unread(approver, holds(NotificationType.GameShareAwaitingApproval, waiting.id));

        // The one that waits, and nothing about the two that took effect.
        expect(told.map((notification) => [notification.type, notification.payload['shareId']])).toEqual([
          [NotificationType.GameShareAwaitingApproval, waiting.id],
        ]);
      }

      // The reader is told of none of the three. A share to them by name tells
      // them, and is the notification waited for.
      const byName = await sharedWith(owner, sentinelGame.id, { userId: reader.user.id });
      const readerList = await unread(reader, holds(NotificationType.GameShareReceived, byName.id));

      expect(readerList.map((notification) => notification.type)).toEqual([NotificationType.GameShareReceived]);
    });
  });
});
