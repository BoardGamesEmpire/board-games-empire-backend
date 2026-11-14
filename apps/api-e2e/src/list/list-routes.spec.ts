import { ListKind, Reach, WishlistPriority } from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { arrangeGame, arrangeList, arrangePlatformGame, findWishlist } from './list-fixtures';
import {
  listEntriesEnvelope,
  listEntryEnvelope,
  listEnvelope,
  listsEnvelope,
  reorderedEntriesEnvelope,
  reorderedListsEnvelope,
} from './list-wire';

/**
 * The list and list entry routes over a real api and database (#1241): the
 * wishlist every user is given, the rules that tell it from a custom list, what
 * an entry may name, and the whole-order reorder that a concurrent add makes stale.
 * Who may read and write is in `list-authorization.spec.ts`.
 */
describe('list routes (#1241)', () => {
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

  const entriesPath = (listId: string) => `/api/lists/${listId}/entries`;

  const addEntry = (actor: AuthenticatedActor, listId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(entriesPath(listId)).set(actor.headers).send(body);

  const readEntries = async (actor: AuthenticatedActor, listId: string) =>
    listEntriesEnvelope(
      await request(baseUrl).get(entriesPath(listId)).set(actor.headers).expect(200),
      'GET /api/lists/:listId/entries',
    ).entries;

  it('gives a newly signed-up user exactly one wishlist with no name (#1241)', async () => {
    const user = await actors.user();

    const page = listsEnvelope(
      await request(baseUrl).get('/api/lists').set(user.headers).expect(200),
      'GET /api/lists',
    );

    expect(page.total).toBe(1);
    const [wishlist] = page.lists;
    expect(wishlist.kind).toBe(ListKind.Wishlist);
    // Without a name a client shows its own translated "Wishlist".
    expect(wishlist.name).toBeNull();
    expect(wishlist.userId).toBe(user.user.id);
    expect(wishlist.reach).toBe(Reach.Private);
    expect(await db.client.list.count({ where: { userId: user.user.id, kind: ListKind.Wishlist } })).toBe(1);
  });

  it('refuses to delete the wishlist with WISHLIST_UNDELETABLE and deletes a custom list with its entries (#1241)', async () => {
    const user = await actors.user();
    const wishlist = await findWishlist(db.client, user.user.id);
    const custom = listEnvelope(
      await request(baseUrl).post('/api/lists').set(user.headers).send({ name: 'Top 100' }).expect(201),
      'POST /api/lists',
    );
    const game = await arrangeGame(db.client);
    await addEntry(user, custom.id, { gameId: game.id }).expect(201);

    const refused = await request(baseUrl).delete(`/api/lists/${wishlist.id}`).set(user.headers).expect(409);
    expect(refused.body.code).toBe('WISHLIST_UNDELETABLE');
    expect(await db.client.list.count({ where: { id: wishlist.id } })).toBe(1);

    await request(baseUrl).delete(`/api/lists/${custom.id}`).set(user.headers).expect(200);
    expect(await db.client.list.count({ where: { id: custom.id } })).toBe(0);
    expect(await db.client.listEntry.count({ where: { listId: custom.id } })).toBe(0);
    // The game stays: only the list's entries went with it.
    expect(await db.client.game.count({ where: { id: game.id } })).toBe(1);
  });

  it('takes a game on any platform or one platform game, once each per list (#1241)', async () => {
    const user = await actors.user();
    const list = await arrangeList(db.client, user.user.id);
    const { gameId, platformGameId } = await arrangePlatformGame(db.client);

    const byGame = listEntryEnvelope(await addEntry(user, list.id, { gameId }).expect(201), 'POST entry by game');
    expect(byGame.gameId).toBe(gameId);
    expect(byGame.platformGameId).toBeNull();
    expect(byGame.game?.id).toBe(gameId);

    // "Catan" on any platform and "Catan" on one platform are different entries.
    const byPlatformGame = listEntryEnvelope(
      await addEntry(user, list.id, { platformGameId }).expect(201),
      'POST entry by platform game',
    );
    expect(byPlatformGame.platformGameId).toBe(platformGameId);
    expect(byPlatformGame.gameId).toBeNull();
    expect(byPlatformGame.platformGame?.game.id).toBe(gameId);
    expect(byPlatformGame.position).toBe(byGame.position + 1);

    expect((await addEntry(user, list.id, { gameId }).expect(409)).body.code).toBe('LIST_ENTRY_EXISTS');
    expect((await addEntry(user, list.id, { platformGameId }).expect(409)).body.code).toBe('LIST_ENTRY_EXISTS');

    expect((await addEntry(user, list.id, { gameId, platformGameId }).expect(400)).body.code).toBe(
      'LIST_ENTRY_ONE_TARGET',
    );
    expect((await addEntry(user, list.id, {}).expect(400)).body.code).toBe('LIST_ENTRY_ONE_TARGET');
    expect(await db.client.listEntry.count({ where: { listId: list.id } })).toBe(2);
  });

  it("keeps the wishlist's priorities to the wishlist (#1241)", async () => {
    const user = await actors.user();
    const wishlist = await findWishlist(db.client, user.user.id);
    const custom = await arrangeList(db.client, user.user.id);
    const [first, second] = await Promise.all([arrangeGame(db.client), arrangeGame(db.client)]);

    const onWishlist = listEntryEnvelope(
      await addEntry(user, wishlist.id, { gameId: first.id, priority: WishlistPriority.MustHave }).expect(201),
      'POST entry with a priority on the wishlist',
    );
    expect(onWishlist.priority).toBe(WishlistPriority.MustHave);

    const refused = await addEntry(user, custom.id, { gameId: first.id, priority: WishlistPriority.MustHave }).expect(
      400,
    );
    expect(refused.body.code).toBe('LIST_PRIORITY_WISHLIST_ONLY');

    // The same refusal on an update, and the control that the same entry takes no priority silently.
    const plain = listEntryEnvelope(await addEntry(user, custom.id, { gameId: second.id }).expect(201), 'POST plain');
    expect(plain.priority).toBeNull();
    const refusedUpdate = await request(baseUrl)
      .patch(`${entriesPath(custom.id)}/${plain.id}`)
      .set(user.headers)
      .send({ priority: WishlistPriority.LoveToHave })
      .expect(400);
    expect(refusedUpdate.body.code).toBe('LIST_PRIORITY_WISHLIST_ONLY');

    const changed = listEntryEnvelope(
      await request(baseUrl)
        .patch(`${entriesPath(wishlist.id)}/${onWishlist.id}`)
        .set(user.headers)
        .send({ priority: WishlistPriority.LikeToHave })
        .expect(200),
      'PATCH wishlist entry priority',
    );
    expect(changed.priority).toBe(WishlistPriority.LikeToHave);
  });

  // The reorder writes the whole order, so it must name exactly the entries the
  // list holds. A client that built its order before another device added an
  // entry must be told to reload, and nothing may be written.
  it("reorders a list's entries, and answers LIST_ORDER_STALE to an order missing an entry added meanwhile (#1241)", async () => {
    const user = await actors.user();
    const list = await arrangeList(db.client, user.user.id);
    const [gameA, gameB, gameC] = await Promise.all([
      arrangeGame(db.client),
      arrangeGame(db.client),
      arrangeGame(db.client),
    ]);
    const a = listEntryEnvelope(await addEntry(user, list.id, { gameId: gameA.id }).expect(201), 'POST A');
    const b = listEntryEnvelope(await addEntry(user, list.id, { gameId: gameB.id }).expect(201), 'POST B');
    const orderPath = `${entriesPath(list.id)}/order`;

    // The client reads [A, B] ...
    expect((await readEntries(user, list.id)).map((entry) => entry.id)).toEqual([a.id, b.id]);
    // ... another device adds C ...
    const c = listEntryEnvelope(await addEntry(user, list.id, { gameId: gameC.id }).expect(201), 'POST C');

    // ... and the client's order, missing C, is refused whole.
    const stale = await request(baseUrl)
      .put(orderPath)
      .set(user.headers)
      .send({ entryIds: [b.id, a.id] })
      .expect(409);
    expect(stale.body.code).toBe('LIST_ORDER_STALE');
    expect((await readEntries(user, list.id)).map((entry) => entry.id)).toEqual([a.id, b.id, c.id]);

    // An unknown id, and a repeated one, are no better.
    const unknown = await request(baseUrl)
      .put(orderPath)
      .set(user.headers)
      .send({ entryIds: [a.id, b.id, 'not-an-entry'] })
      .expect(409);
    expect(unknown.body.code).toBe('LIST_ORDER_STALE');
    await request(baseUrl)
      .put(orderPath)
      .set(user.headers)
      .send({ entryIds: [a.id, a.id, b.id] })
      .expect(400);

    // The control: the full set lands, renumbered from 0.
    const reordered = reorderedEntriesEnvelope(
      await request(baseUrl)
        .put(orderPath)
        .set(user.headers)
        .send({ entryIds: [c.id, a.id, b.id] })
        .expect(200),
      'PUT entries/order',
    );
    expect(reordered.map((entry) => [entry.id, entry.position])).toEqual([
      [c.id, 0],
      [a.id, 1],
      [b.id, 2],
    ]);
    expect((await readEntries(user, list.id)).map((entry) => entry.id)).toEqual([c.id, a.id, b.id]);
  });

  // The list reorder writes the whole order of the acting user's lists, the
  // wishlist among them, so it must name exactly the lists they hold. One built
  // before a list was added or removed is refused whole, as one naming another
  // user's list is, and nothing moves.
  it("reorders the acting user's lists, and answers LIST_ORDER_STALE to an order that is not exactly their lists (#1241)", async () => {
    const user = await actors.user();
    const stranger = await actors.user();
    const wishlist = await findWishlist(db.client, user.user.id);
    const a = await arrangeList(db.client, user.user.id, { position: 1 });
    const b = await arrangeList(db.client, user.user.id, { position: 2 });
    const strangersList = await arrangeList(db.client, stranger.user.id);
    const ORDER_PATH = '/api/lists/order';

    const positions = () =>
      db.client.list.findMany({
        where: { userId: { in: [user.user.id, stranger.user.id] } },
        select: { id: true, position: true },
        orderBy: { id: 'asc' },
      });
    const before = await positions();

    // A repeated id is a malformed body, refused before any list is read.
    await request(baseUrl)
      .put(ORDER_PATH)
      .set(user.headers)
      .send({ listIds: [b.id, wishlist.id, a.id, a.id] })
      .expect(400);

    // Missing a list: one added since the client read them.
    const missing = await request(baseUrl)
      .put(ORDER_PATH)
      .set(user.headers)
      .send({ listIds: [b.id, a.id] })
      .expect(409);
    expect(missing.body.code).toBe('LIST_ORDER_STALE');

    // Naming another user's list in place of one of theirs, the same size as the set.
    const foreign = await request(baseUrl)
      .put(ORDER_PATH)
      .set(user.headers)
      .send({ listIds: [b.id, strangersList.id, a.id] })
      .expect(409);
    expect(foreign.body.code).toBe('LIST_ORDER_STALE');

    expect(await positions()).toEqual(before);

    // The control: the full set lands, renumbered from 0, and a read sees that order.
    const reordered = reorderedListsEnvelope(
      await request(baseUrl)
        .put(ORDER_PATH)
        .set(user.headers)
        .send({ listIds: [b.id, wishlist.id, a.id] })
        .expect(200),
      'PUT /api/lists/order',
    );
    expect(reordered.map((list) => [list.id, list.position])).toEqual([
      [b.id, 0],
      [wishlist.id, 1],
      [a.id, 2],
    ]);
    const page = listsEnvelope(
      await request(baseUrl).get('/api/lists').set(user.headers).expect(200),
      'GET /api/lists after the reorder',
    );
    expect(page.lists.map((list) => list.id)).toEqual([b.id, wishlist.id, a.id]);
    // The stranger's list never moved.
    expect((await db.client.list.findUniqueOrThrow({ where: { id: strangersList.id } })).position).toBe(
      strangersList.position,
    );
  });

  // Only the wishlist may go without a name, since a client shows its own
  // translated "Wishlist" in its place; a custom list has nothing to show
  // instead. No route changes a list's kind, so a body naming one is refused.
  it('renames the wishlist and clears its name, refuses a nameless custom list, and refuses a body naming a kind (#1241)', async () => {
    const user = await actors.user();
    const wishlist = await findWishlist(db.client, user.user.id);
    const custom = await arrangeList(db.client, user.user.id);
    const patch = (listId: string, body: Record<string, unknown>) =>
      request(baseUrl).patch(`/api/lists/${listId}`).set(user.headers).send(body);

    const renamed = listEnvelope(await patch(wishlist.id, { name: 'Birthday ideas' }).expect(200), 'PATCH rename');
    expect(renamed.name).toBe('Birthday ideas');

    const cleared = listEnvelope(await patch(wishlist.id, { name: null }).expect(200), 'PATCH clear the name');
    expect(cleared.name).toBeNull();
    expect(cleared.kind).toBe(ListKind.Wishlist);

    const nameless = await patch(custom.id, { name: null }).expect(400);
    expect(nameless.body.code).toBe('LIST_NAME_REQUIRED');
    expect((await db.client.list.findUniqueOrThrow({ where: { id: custom.id } })).name).toBe(custom.name);

    // Beside a field that would otherwise be written, so the refusal is the kind's and nothing lands.
    await patch(wishlist.id, { name: 'Renamed', kind: ListKind.Custom }).expect(400);
    await patch(custom.id, { name: 'Renamed', kind: ListKind.Wishlist }).expect(400);
    const [wishlistAfter, customAfter] = await Promise.all([
      db.client.list.findUniqueOrThrow({ where: { id: wishlist.id } }),
      db.client.list.findUniqueOrThrow({ where: { id: custom.id } }),
    ]);
    expect([wishlistAfter.kind, wishlistAfter.name]).toEqual([ListKind.Wishlist, null]);
    expect([customAfter.kind, customAfter.name]).toEqual([ListKind.Custom, custom.name]);
  });

  // A list shows its entries to whoever can read the list, not only to those
  // who could read each game: the owner chose what to put on it. This is the
  // intended behaviour.
  it("shows a Public list's reader the owner's own Private game, since putting it there was the owner's choice (#1241)", async () => {
    const owner = await actors.user();
    const reader = await actors.user();
    const list = await arrangeList(db.client, owner.user.id, { reach: Reach.Public });
    const privateGame = await arrangeGame(db.client, { createdById: owner.user.id, reach: Reach.Private });

    await addEntry(owner, list.id, { gameId: privateGame.id }).expect(201);

    // The control: the reader can't read the game itself, only see it on the owner's list.
    await addEntry(reader, (await arrangeList(db.client, reader.user.id)).id, { gameId: privateGame.id }).expect(404);
    const entries = await readEntries(reader, list.id);
    expect(entries.map((entry) => entry.game?.id)).toEqual([privateGame.id]);
  });

  // A game can leave the list owner's reach after it was added, when its
  // creator makes it Private. This pins today's behaviour, the one collection
  // rows share, pending a design issue on what a list should do with a game
  // its creator later withdrew; it may change then.
  it("still embeds another user's game on a list after its creator made it Private, as collection rows do (#1241)", async () => {
    const owner = await actors.user();
    const creator = await actors.user();
    const reader = await actors.user();
    const list = await arrangeList(db.client, owner.user.id, { reach: Reach.Public });
    const game = await arrangeGame(db.client, { createdById: creator.user.id, reach: Reach.Public });

    // The owner could read the game when adding it.
    await addEntry(owner, list.id, { gameId: game.id }).expect(201);
    await db.client.game.update({ where: { id: game.id }, data: { reach: Reach.Private } });

    // The control: the owner can no longer add it to another list, so the game is out of their reach now ...
    const otherList = await arrangeList(db.client, owner.user.id);
    await addEntry(owner, otherList.id, { gameId: game.id }).expect(404);
    // ... but the entry already on the list still shows it to the list's reader.
    const entries = await readEntries(reader, list.id);
    expect(entries.map((entry) => entry.game?.id)).toEqual([game.id]);
  });

  it("keeps an entry's Markdown note exactly as written (#1241)", async () => {
    const user = await actors.user();
    const list = await arrangeList(db.client, user.user.id);
    const game = await arrangeGame(db.client);
    const note = '# Why\n\n## Reasons\n\n- plays in <b>30</b> minutes\n- `solo` mode\n\n1. ask Sam\n2. buy *used*  \n';

    const created = listEntryEnvelope(
      await addEntry(user, list.id, { gameId: game.id, note }).expect(201),
      'POST note',
    );
    expect(created.note).toBe(note);

    const [read] = await readEntries(user, list.id);
    expect(read.note).toBe(note);
    expect((await db.client.listEntry.findUniqueOrThrow({ where: { id: created.id } })).note).toBe(note);
  });

  it("lists staff only their own lists while staff still read a stranger's Private list by id (#1241)", async () => {
    const [serverOwner, admin, moderator, plainUser, stranger] = await Promise.all([
      actors.owner(),
      actors.admin(),
      actors.moderator(),
      actors.user(),
      actors.user(),
    ]);
    const strangersList = await arrangeList(db.client, stranger.user.id, { reach: Reach.Private });
    const staff = [
      ['an admin', admin],
      ['a moderator', moderator],
      ["the server's Owner", serverOwner],
    ] as const;

    // The control: staff read the stranger's list by id through their read grants, and a plain user is refused
    // the same list, so the list below can't pass merely because nobody could read it.
    for (const [who, actor] of staff) {
      const read = listEnvelope(
        await request(baseUrl).get(`/api/lists/${strangersList.id}`).set(actor.headers).expect(200),
        `GET /api/lists/:id as ${who}`,
      );
      expect(read.id).toBe(strangersList.id);
    }
    await request(baseUrl).get(`/api/lists/${strangersList.id}`).set(plainUser.headers).expect(404);

    for (const [who, actor] of staff) {
      const page = listsEnvelope(
        await request(baseUrl).get('/api/lists').set(actor.headers).expect(200),
        `GET /api/lists as ${who}`,
      );
      // Only their own: the wishlist provisioning gave them.
      expect(page.lists.map((list) => list.userId)).toEqual([actor.user.id]);
      expect(page.lists.map((list) => list.id)).not.toContain(strangersList.id);
      expect(page.total).toBe(1);
    }
  });
});
