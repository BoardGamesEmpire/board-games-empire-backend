import { FriendshipStatus, ListKind, Reach, ResourceType } from '@bge/database';
import {
  arrangeExtendedNetwork,
  arrangeFriendship,
  befriend,
  createActors,
  type Actors,
  type AuthenticatedActor,
} from '@bge/testing-e2e';
import request from 'supertest';
import { mintApiKey } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { arrangeGame, arrangeList, findWishlist } from './list-fixtures';
import { listEntriesEnvelope, listsEnvelope } from './list-wire';

/**
 * Who may read and write another user's lists and their entries (#1241),
 * against real rows and the real anonymous sign-in.
 *
 * A list has its own reach, Private unless its owner says otherwise, on the
 * ladder the collection uses. The owner alone writes. A list's entries are read
 * with the list. The collection's "show my collection to friends" preference
 * does not apply, and an anonymous user holds no list permission at all.
 *
 * Every denial follows a control showing the same row IS readable by someone
 * else, so a denial cannot pass because the row was unreadable to everyone.
 * Every owner here also holds the wishlist provisioning gave them, which is
 * Private: it is part of the Private rows each list page must leave out.
 */
describe('list authorization (#1241)', () => {
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

  const listsOf = (actor: AuthenticatedActor, userId: string) =>
    request(baseUrl).get(`/api/users/${userId}/lists`).set(actor.headers);

  const idsListedFor = async (actor: AuthenticatedActor, ownerId: string, who: string) =>
    listsEnvelope(await listsOf(actor, ownerId).expect(200), `GET /api/users/:userId/lists as ${who}`)
      .lists.map((list) => list.id)
      .sort();

  const entriesOf = (actor: AuthenticatedActor, listId: string) =>
    request(baseUrl).get(`/api/lists/${listId}/entries`).set(actor.headers);

  const addGame = async (ownerId: string) => {
    const game = await arrangeGame(db.client, { createdById: ownerId });
    return game.id;
  };

  it("serves a friend the owner's Friends and Public lists and not the Private one (#1241)", async () => {
    const owner = await actors.user();
    const friend = await actors.user();
    await befriend(db.client, owner, friend);

    const friendsList = await arrangeList(db.client, owner.user.id, { reach: Reach.Friends });
    const publicList = await arrangeList(db.client, owner.user.id, { reach: Reach.Public });
    await arrangeList(db.client, owner.user.id, { reach: Reach.Private });

    expect(await idsListedFor(friend, owner.user.id, 'a friend')).toEqual([friendsList.id, publicList.id].sort());

    const page = listsEnvelope(await listsOf(friend, owner.user.id).expect(200), 'GET /api/users/:userId/lists');
    // Counted over the same scope as the page (#230), not the owner's whole shelf.
    expect(page.total).toBe(2);
  });

  it('serves a friend of a friend the FriendsOfFriends list (#1241)', async () => {
    const [owner, sharedFriend, viewer] = await Promise.all([actors.user(), actors.user(), actors.user()]);
    await befriend(db.client, owner, sharedFriend);
    await befriend(db.client, viewer, sharedFriend);
    const friendsList = await arrangeList(db.client, owner.user.id, { reach: Reach.Friends });
    const widerList = await arrangeList(db.client, owner.user.id, { reach: Reach.FriendsOfFriends });

    // The control: a Friends list is the owner's friends' alone, so the viewer reads the wider one only.
    expect(await idsListedFor(viewer, owner.user.id, 'a friend of a friend')).toEqual([widerList.id]);
    expect(await idsListedFor(sharedFriend, owner.user.id, 'the shared friend')).toEqual(
      [friendsList.id, widerList.id].sort(),
    );
  });

  it('serves a reader three steps away the ExtendedNetwork list, and not across a block (#1241)', async () => {
    const [owner, blockingOwner, viewer] = await Promise.all([actors.user(), actors.user(), actors.user()]);
    await arrangeExtendedNetwork(db.client, owner, viewer, 3);
    await arrangeExtendedNetwork(db.client, blockingOwner, viewer, 3);
    await arrangeFriendship(db.client, blockingOwner, viewer, FriendshipStatus.Blocked);
    const reachable = await arrangeList(db.client, owner.user.id, { reach: Reach.ExtendedNetwork });
    const blocked = await arrangeList(db.client, blockingOwner.user.id, { reach: Reach.ExtendedNetwork });

    expect(await idsListedFor(viewer, owner.user.id, 'a reader three steps away')).toEqual([reachable.id]);

    expect(await idsListedFor(viewer, blockingOwner.user.id, 'a reader the owner blocked')).not.toContain(blocked.id);
    await request(baseUrl).get(`/api/lists/${blocked.id}`).set(viewer.headers).expect(404);
    // The control: the same list is readable on the route that doesn't cross the block.
    await request(baseUrl).get(`/api/lists/${reachable.id}`).set(viewer.headers).expect(200);
  });

  it('serves every signed-in user a Public list, and refuses an anonymous user every list route (#1241)', async () => {
    const owner = await actors.user();
    const stranger = await actors.user();
    const anonymousUser = await actors.anonymous();
    const publicList = await arrangeList(db.client, owner.user.id, { reach: Reach.Public });
    const gameId = await addGame(owner.user.id);
    await db.client.listEntry.create({ data: { listId: publicList.id, gameId } });

    // The control: a signed-in stranger reads the list, its row and its entries.
    expect(await idsListedFor(stranger, owner.user.id, 'a signed-in stranger')).toEqual([publicList.id]);
    await request(baseUrl).get(`/api/lists/${publicList.id}`).set(stranger.headers).expect(200);
    await entriesOf(stranger, publicList.id).expect(200);

    // An anonymous user holds `AnonymousUser` instead of `User`, which carries no list permission: 403, not an
    // empty page.
    await listsOf(anonymousUser, owner.user.id).expect(403);
    await request(baseUrl).get('/api/lists').set(anonymousUser.headers).expect(403);
    await request(baseUrl).get(`/api/lists/${publicList.id}`).set(anonymousUser.headers).expect(403);
    await entriesOf(anonymousUser, publicList.id).expect(403);
    await request(baseUrl).post('/api/lists').set(anonymousUser.headers).send({ name: 'e2e list' }).expect(403);
  });

  it("serves a friend a readable list's entries and 404s a Private list's entries (#1241)", async () => {
    const owner = await actors.user();
    const friend = await actors.user();
    await befriend(db.client, owner, friend);
    const friendsList = await arrangeList(db.client, owner.user.id, { reach: Reach.Friends });
    const privateList = await arrangeList(db.client, owner.user.id, { reach: Reach.Private });
    const gameId = await addGame(owner.user.id);
    const friendsEntry = await db.client.listEntry.create({ data: { listId: friendsList.id, gameId } });
    await db.client.listEntry.create({ data: { listId: privateList.id, gameId } });

    const page = listEntriesEnvelope(
      await entriesOf(friend, friendsList.id).expect(200),
      "GET /api/lists/:listId/entries on a friend's Friends list",
    );
    expect(page.entries.map((entry) => entry.id)).toEqual([friendsEntry.id]);

    const refused = await entriesOf(friend, privateList.id).expect(404);
    expect(refused.body.code).toBe('LIST_NOT_FOUND');
    // The owner reads the same list, so the 404 is about the friend's scope.
    await entriesOf(owner, privateList.id).expect(200);
  });

  it('lets no one but the owner write a list or its entries, answering 404 (#1241)', async () => {
    const owner = await actors.user();
    const friend = await actors.user();
    await befriend(db.client, owner, friend);
    const list = await arrangeList(db.client, owner.user.id, { reach: Reach.Friends, name: 'owner list' });
    const gameId = await addGame(owner.user.id);
    const entry = await db.client.listEntry.create({ data: { listId: list.id, gameId } });

    // The control: the friend reads the list, so the refusals below are about writing.
    await request(baseUrl).get(`/api/lists/${list.id}`).set(friend.headers).expect(200);

    await request(baseUrl).patch(`/api/lists/${list.id}`).set(friend.headers).send({ name: 'taken over' }).expect(404);
    await request(baseUrl).delete(`/api/lists/${list.id}`).set(friend.headers).expect(404);
    await request(baseUrl).post(`/api/lists/${list.id}/entries`).set(friend.headers).send({ gameId }).expect(404);
    await request(baseUrl)
      .patch(`/api/lists/${list.id}/entries/${entry.id}`)
      .set(friend.headers)
      .send({ note: 'mine now' })
      .expect(404);
    await request(baseUrl).delete(`/api/lists/${list.id}/entries/${entry.id}`).set(friend.headers).expect(404);
    await request(baseUrl)
      .put(`/api/lists/${list.id}/entries/order`)
      .set(friend.headers)
      .send({ entryIds: [entry.id] })
      .expect(404);

    const unchanged = await db.client.list.findUniqueOrThrow({ where: { id: list.id } });
    expect(unchanged.name).toBe('owner list');
    expect(await db.client.listEntry.count({ where: { listId: list.id } })).toBe(1);
    expect((await db.client.listEntry.findUniqueOrThrow({ where: { id: entry.id } })).note).toBeNull();

    // The owner's own PATCH lands.
    await request(baseUrl).patch(`/api/lists/${list.id}`).set(owner.headers).send({ name: 'renamed' }).expect(200);
  });

  // The list reorder renumbers every list the owner holds. A key whose
  // update:list grant is pinned to one list passes the route's policy check,
  // but renumbering that list alone would give it a position the wishlist
  // already holds, so it is refused whole and nothing moves.
  it('refuses a list reorder from a key that may change only some of the lists with LIST_ORDER_FORBIDDEN (#1241)', async () => {
    const owner = await actors.user();
    const wishlist = await findWishlist(db.client, owner.user.id);
    const custom = await arrangeList(db.client, owner.user.id, { position: 1 });
    const update = { slugs: ['update:list'], resourceType: ResourceType.List };
    const pinned = await mintApiKey(baseUrl, db.client, owner, { ...update, resourceId: custom.id });
    const unpinned = await mintApiKey(baseUrl, db.client, owner, update);
    const positions = () =>
      db.client.list.findMany({
        where: { userId: owner.user.id },
        select: { id: true, position: true },
        orderBy: { id: 'asc' },
      });
    const before = await positions();

    // The control: the pinned key does change the list it is pinned to.
    await request(baseUrl).patch(`/api/lists/${custom.id}`).set(pinned.headers).send({ name: 'pinned' }).expect(200);

    for (const listIds of [[custom.id], [custom.id, wishlist.id]]) {
      const refused = await request(baseUrl).put('/api/lists/order').set(pinned.headers).send({ listIds }).expect(403);
      expect(refused.body.code).toBe('LIST_ORDER_FORBIDDEN');
    }
    expect(await positions()).toEqual(before);

    // An unpinned key holding the same slug reorders them.
    await request(baseUrl)
      .put('/api/lists/order')
      .set(unpinned.headers)
      .send({ listIds: [custom.id, wishlist.id] })
      .expect(200);
    const after = await db.client.list.findMany({ where: { userId: owner.user.id }, orderBy: { position: 'asc' } });
    expect(after.map(({ id, position }) => [id, position])).toEqual([
      [custom.id, 0],
      [wishlist.id, 1],
    ]);
  });

  // The create route's policy check reads only the action and the type. A key
  // whose create:list grant is pinned to one list id names a list that already
  // exists, so the service's check of the new list refuses it.
  it('refuses a list create from a key whose create:list grant is pinned to one list (#1241)', async () => {
    const owner = await actors.user();
    const custom = await arrangeList(db.client, owner.user.id);
    const create = { slugs: ['create:list'], resourceType: ResourceType.List };
    const pinned = await mintApiKey(baseUrl, db.client, owner, { ...create, resourceId: custom.id });
    const unpinned = await mintApiKey(baseUrl, db.client, owner, create);
    const held = () => db.client.list.count({ where: { userId: owner.user.id } });
    const before = await held();

    await request(baseUrl).post('/api/lists').set(pinned.headers).send({ name: 'pinned' }).expect(403);
    expect(await held()).toBe(before);

    // The control: an unpinned key holding the same slug creates the list.
    await request(baseUrl).post('/api/lists').set(unpinned.headers).send({ name: 'unpinned' }).expect(201);
    expect(await held()).toBe(before + 1);
  });

  it("ignores the owner's show-collection-to-friends preference (#1241)", async () => {
    const owner = await actors.user();
    const friend = await actors.user();
    await befriend(db.client, owner, friend);
    const list = await arrangeList(db.client, owner.user.id, { reach: Reach.Friends });
    await db.client.userPreferences.update({
      where: { userId: owner.user.id },
      data: { showCollectionToFriends: false },
    });

    expect(await idsListedFor(friend, owner.user.id, 'a friend of an owner hiding their collection')).toEqual([
      list.id,
    ]);
    await request(baseUrl).get(`/api/lists/${list.id}`).set(friend.headers).expect(200);
    // The wishlist is a list like any other: Private by default, whatever the preference says.
    const wishlist = await db.client.list.findFirstOrThrow({
      where: { userId: owner.user.id, kind: ListKind.Wishlist },
    });
    await request(baseUrl).get(`/api/lists/${wishlist.id}`).set(friend.headers).expect(404);
  });
});
