import { befriend, createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { listFriendshipsEnvelope } from './friendship-wire';

/**
 * Which rows `GET /api/friendships` answers with, over the real route (#515).
 *
 * The list is the acting user's own friendships. It used to take the actor's
 * ceiling as its whole answer, and staff and the Owner read every friendship on
 * the server:
 * Admin and Moderator through `read:public_content`, an unconditioned `read`
 * on `all`, and the Owner through `manage:all`. So each of them was handed
 * everyone's. Now each gets only their own.
 *
 * `Friendship` has no detail route to show that those permissions still reach a
 * stranger's row, so the control reads a stranger's household by id instead.
 * The permission that reaches it is the same wildcard that widened this list,
 * and a user with only the base role is refused that household. Without the
 * control, a list that left the strangers' friendship out because nobody could
 * read it would pass too.
 *
 * `GET /api/friendships/requests` gets no test here: its `where` always named
 * the acting user as addressee, so composing it changed nobody's rows.
 */
describe('friendship read scope', () => {
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

  const listFriendships = (actor: SessionActor) => request(baseUrl).get('/api/friendships').set(actor.headers);

  const readHousehold = (actor: SessionActor, id: string) =>
    request(baseUrl).get(`/api/households/${id}`).set(actor.headers);

  /** Befriends the two, and hands back the friendship's id. */
  const friendshipBetween = async (a: SessionActor, b: SessionActor): Promise<string> => {
    await befriend(db.client, a, b);

    const { id } = await db.client.friendship.findUniqueOrThrow({
      where: { pairKey: [a.user.id, b.user.id].sort().join(':') },
      select: { id: true },
    });

    return id;
  };

  it("lists staff and the Owner only their own friendships, while each reads a stranger's household by id", async () => {
    // Every actor before any of them issues an authenticated request (the
    // ordering rule). Concurrent factory calls share one in-flight Owner mint.
    const [serverOwner, admin, moderator, plainUser, ...others] = await Promise.all([
      actors.owner(),
      actors.admin(),
      actors.moderator(),
      actors.user(),
      actors.user(),
      actors.user(),
      actors.user(),
      actors.user(),
      actors.user(),
    ]);
    const [friendOfAdmin, friendOfModerator, friendOfOwner, stranger, otherStranger] = others;

    // A friendship none of them is part of, so "only their own" is a real
    // exclusion rather than an artefact of there being nothing else to see.
    await friendshipBetween(stranger, otherStranger);
    const { household: strangersHousehold } = await actors.householdWithMembers({ owner: stranger });

    const staffAndOwner = [
      ['an admin', admin, await friendshipBetween(admin, friendOfAdmin)],
      ['a moderator', moderator, await friendshipBetween(friendOfModerator, moderator)],
      ["the server's Owner", serverOwner, await friendshipBetween(serverOwner, friendOfOwner)],
    ] as const;

    // The control. Each of their permissions reaches a stranger's household,
    // which the base role is refused, so the reads come from those permissions
    // and not from the household being open to everyone.
    for (const [, actor] of staffAndOwner) {
      await readHousehold(actor, strangersHousehold.id).expect(200);
    }
    await readHousehold(plainUser, strangersHousehold.id).expect(403);

    for (const [who, actor, ownId] of staffAndOwner) {
      const page = listFriendshipsEnvelope(await listFriendships(actor).expect(200), `GET /api/friendships as ${who}`);
      expect(page.friendships.map((friendship) => friendship.id)).toEqual([ownId]);
      expect(page.total).toBe(1);
    }
  });
});
