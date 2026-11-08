import { FriendshipStatus, Reach } from '@bge/database';
import { EXTENDED_NETWORK_QUEUE, ExtendedNetworkJobNames, REBUILD_ALL_BATCH_SIZE } from '@bge/friendship';
import { wrapJobData } from '@bge/queue-actor-context';
import { befriend, createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { drainQueue, markQueueEvents, type DrainQueueOptions } from '../support/queues';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { useWorker } from '../support/worker';
import { friendshipEnvelope } from './friendship-wire';

const FRIENDSHIPS_PATH = '/api/friendships';
const GAMES_PATH = '/api/games';

/**
 * The extended network's table, kept by the real worker (#497). A friendship
 * change through the routes queues a rebuild around each of the pair, and
 * each test drains them before it reads the rows. The rest of a graph is
 * written straight to the database, which queues nothing, so a drain counts
 * exactly the jobs of the change under test. The jobs merge per user, so
 * changes made through the routes in a row would queue a number of jobs that
 * depends on timing. A full rebuild is one job that runs a batch of users at
 * a time, moving itself back to the queue between batches, so its drains
 * allow steps.
 */
describe('the extended network table (#497)', () => {
  const baseUrl = requireBaseUrl(process.env);

  let db: TestDatabase;
  let actors: Actors;

  const workerQueue = useWorker();
  const extendedNetworkQueue = () => workerQueue(EXTENDED_NETWORK_QUEUE);

  beforeAll(async () => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });

    // The worker queues a full rebuild as it starts. It finishes here, so
    // each test's drain counts only the jobs its own change queues. Draining
    // it from the start of the stream also proves the worker queued it.
    await drainQueue(extendedNetworkQueue(), { queueName: EXTENDED_NETWORK_QUEUE, id: '0-0' }, 1, { steps: true });
  });

  afterAll(async () => {
    await db.close();
  });

  const users = (count: number) => Promise.all(Array.from({ length: count }, () => actors.user()));

  /** Runs `change` and waits for the rebuilds it queues, one around each user of the friendship. */
  const drained = async (change: () => Promise<unknown>, jobs = 2, options: DrainQueueOptions = {}) => {
    const queue = extendedNetworkQueue();
    const mark = await markQueueEvents(queue);

    await change();
    await drainQueue(queue, mark, jobs, options);

    return mark;
  };

  /** A friend request through the route. It queues nothing: a request is no friendship step. */
  const requestFriendship = async (from: AuthenticatedActor, to: AuthenticatedActor) =>
    friendshipEnvelope(
      await request(baseUrl).post(FRIENDSHIPS_PATH).set(from.headers).send({ addresseeId: to.user.id }).expect(201),
      'POST /api/friendships',
    ).id;

  const respond = (actor: AuthenticatedActor, id: string, status: FriendshipStatus) =>
    request(baseUrl).patch(`${FRIENDSHIPS_PATH}/${id}`).set(actor.headers).send({ status }).expect(200);

  /** A request and its accept through the routes, with the rebuilds the accept queues drained. */
  const accept = (requester: AuthenticatedActor, addressee: AuthenticatedActor) =>
    drained(async () => {
      const id = await requestFriendship(requester, addressee);
      await respond(addressee, id, FriendshipStatus.Accepted);
    });

  /** An unfriend through the route, with the rebuilds it queues drained. */
  const unfriend = (actor: AuthenticatedActor, other: AuthenticatedActor) =>
    drained(async () => {
      const { id } = await db.client.friendship.findUniqueOrThrow({
        where: { pairKey: [actor.user.id, other.user.id].sort().join(':') },
        select: { id: true },
      });
      await request(baseUrl).delete(`${FRIENDSHIPS_PATH}/${id}`).set(actor.headers).expect(200);
    });

  /** A full rebuild, added through the test's own handle on the worker's queue, and drained. */
  const rebuildAll = () =>
    drained(
      () =>
        extendedNetworkQueue().add(
          ExtendedNetworkJobNames.RebuildAll,
          wrapJobData({}, { actor: { kind: 'system', reason: 'e2e:extended-network' }, correlationId: randomUUID() }),
          { removeOnComplete: true },
        ),
      1,
      { steps: true },
    );

  /** A user's rows, as `{ [otherUserId]: steps }`. */
  const stepsFrom = async (actor: AuthenticatedActor) =>
    Object.fromEntries(
      (
        await db.client.extendedNetwork.findMany({
          where: { userId: actor.user.id },
          select: { otherUserId: true, steps: true },
        })
      ).map((row) => [row.otherUserId, row.steps]),
    );

  /**
   * A user's rows, as `{ [otherUserId]: 'xmin/xmax' }`. A row a rebuild
   * rewrote has a new `xmin`. One it only locked has a new `xmax`: a lock
   * writes the row's header and the WAL too, so a rebuild that leaves a row
   * alone must not lock it either.
   */
  const versionsOf = async (actor: AuthenticatedActor) =>
    Object.fromEntries(
      (
        await db.client.$queryRaw<{ other_user_id: string; version: string }[]>`
          SELECT other_user_id, xmin::text || '/' || xmax::text AS version
          FROM extended_network WHERE user_id = ${actor.user.id}`
      ).map((row) => [row.other_user_id, row.version]),
    );

  const arrangeExtendedNetworkGame = (creator: AuthenticatedActor) =>
    db.client.game.create({
      data: {
        title: `e2e extended network ${randomUUID().slice(0, 8)}`,
        reach: Reach.ExtendedNetwork,
        createdById: creator.user.id,
      },
      select: { id: true },
    });

  const readGame = (actor: AuthenticatedActor, id: string) =>
    request(baseUrl).get(`${GAMES_PATH}/${id}`).set(actor.headers);

  // A–B–C–D–E with a shortcut A–C. The accept of C–D rebuilds every user
  // within two steps of C and of D, which here is the whole chain. A reaches C
  // in one step, not the two through B, and D in two, not three.
  it('writes every pair within three steps of a chain, with the shortest path, after an accept (#497)', async () => {
    const [a, b, c, d, e] = await users(5);
    await befriend(db.client, a, b);
    await befriend(db.client, b, c);
    await befriend(db.client, a, c);
    await befriend(db.client, d, e);

    await accept(c, d);

    expect(await stepsFrom(a)).toEqual({ [b.user.id]: 1, [c.user.id]: 1, [d.user.id]: 2, [e.user.id]: 3 });
    expect(await stepsFrom(e)).toEqual({ [d.user.id]: 1, [c.user.id]: 2, [a.user.id]: 3, [b.user.id]: 3 });

    // Every row has its reverse, at the same steps, and no row pairs a user
    // with themselves.
    const ids = [a, b, c, d, e].map((actor) => actor.user.id);
    const rows = await db.client.extendedNetwork.findMany({ where: { userId: { in: ids } } });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.otherUserId).not.toBe(row.userId);
      expect(rows).toContainEqual({ userId: row.otherUserId, otherUserId: row.userId, steps: row.steps });
    }
  });

  // A–B–C–D has one path, which the unfriend of B–C removes. X–Y–Z–W keeps a
  // second one, X–V–Z–W, past the unfriend of Y–Z.
  it('drops a pair whose only path an unfriend removed, and keeps one another path still serves (#497)', async () => {
    const [a, b, c, d, x, y, z, w, v] = await users(9);
    await befriend(db.client, a, b);
    await befriend(db.client, b, c);
    await befriend(db.client, c, d);
    await befriend(db.client, x, y);
    await befriend(db.client, y, z);
    await befriend(db.client, z, w);
    await befriend(db.client, x, v);
    await befriend(db.client, v, z);
    await rebuildAll();
    const [aGame, xGame] = await Promise.all([arrangeExtendedNetworkGame(a), arrangeExtendedNetworkGame(x)]);

    await readGame(d, aGame.id).expect(200);
    await readGame(w, xGame.id).expect(200);

    await unfriend(b, c);
    await unfriend(y, z);

    await readGame(d, aGame.id).expect(403);
    expect(await stepsFrom(a)).toEqual({ [b.user.id]: 1 });

    await readGame(w, xGame.id).expect(200);
    expect((await stepsFrom(x))[w.user.id]).toBe(3);
  });

  // C–D joins A–B–C to D. A sits within two steps of C, so the rebuild
  // recomputes A's rows: its new row to D is written, and its rows to B and
  // C, whose steps didn't move, are neither rewritten nor locked. X–Y–Z is out
  // of reach of the change.
  it('rewrites only the pairs a change moved, and leaves every other row alone (#497)', async () => {
    const [a, b, c, d, x, y, z] = await users(7);
    await befriend(db.client, a, b);
    await befriend(db.client, b, c);
    await befriend(db.client, x, y);
    await befriend(db.client, y, z);
    await rebuildAll();
    const [aBefore, xBefore] = await Promise.all([versionsOf(a), versionsOf(x)]);
    expect(aBefore[d.user.id]).toBeUndefined();

    await accept(c, d);

    const aAfter = await versionsOf(a);
    expect(aAfter[d.user.id]).toBeDefined();
    expect(aAfter[b.user.id]).toBe(aBefore[b.user.id]);
    expect(aAfter[c.user.id]).toBe(aBefore[c.user.id]);
    expect(await versionsOf(x)).toEqual(xBefore);
  });

  // The table stores no blocks, and a blocked pair three steps apart keeps
  // its row. The permissions check the block in the query, so it refuses at
  // once, and still after the job runs.
  it("leaves a blocked pair's reach to the permissions: a block refuses at once, before the job runs (#497)", async () => {
    const [a, b, c, d] = await users(4);
    await befriend(db.client, a, b);
    await befriend(db.client, b, c);
    await befriend(db.client, c, d);
    await rebuildAll();
    const game = await arrangeExtendedNetworkGame(a);
    await readGame(d, game.id).expect(200);

    const id = await requestFriendship(d, a);
    const queue = extendedNetworkQueue();
    const mark = await markQueueEvents(queue);
    await respond(a, id, FriendshipStatus.Blocked);

    // The rebuilds the block queued wait two seconds before they run.
    await readGame(d, game.id).expect(403);

    await drainQueue(queue, mark, 2);
    expect((await stepsFrom(a))[d.user.id]).toBe(3);
    await readGame(d, game.id).expect(403);
  });

  // Friendships written straight to the database queue nothing, so only the
  // full rebuild writes their rows. A user it finds with no friendship left
  // loses theirs.
  it('rebuilds every pair from the friendships on a full rebuild (#497)', async () => {
    const [a, b, c] = await users(3);
    await befriend(db.client, a, b);
    await befriend(db.client, b, c);
    expect(await stepsFrom(a)).toEqual({});

    await rebuildAll();

    expect(await stepsFrom(a)).toEqual({ [b.user.id]: 1, [c.user.id]: 2 });
    expect(await stepsFrom(c)).toEqual({ [b.user.id]: 1, [a.user.id]: 2 });

    await db.client.friendship.deleteMany({ where: { OR: [{ requesterId: a.user.id }, { addresseeId: a.user.id }] } });
    await rebuildAll();

    expect(await stepsFrom(a)).toEqual({});
    expect(await stepsFrom(c)).toEqual({ [b.user.id]: 1 });
  });

  // A full rebuild runs one batch of users per run of its job, each in its
  // own transaction, so a change's job runs between two batches rather than
  // after the whole run. More users than one batch holds, each with a row no
  // friendship backs, prove every batch ran: none of the rows is left. The
  // users are bare `users` rows, as in the deletion case below.
  it('rebuilds every user across more than one batch, moving back to the queue between them (#497)', async () => {
    const token = randomUUID().slice(0, 8);
    const count = REBUILD_ALL_BATCH_SIZE + 1;
    await db.client.user.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        username: `e2e-batch-${token}-${i}`,
        email: `batch-${token}-${i}@example.test`,
      })),
    });
    const bare = await db.client.user.findMany({
      where: { username: { startsWith: `e2e-batch-${token}-` } },
      select: { id: true },
    });
    expect(bare).toHaveLength(count);

    try {
      await db.client.extendedNetwork.createMany({
        data: bare.map((user, i) => ({ userId: user.id, otherUserId: bare[(i + 1) % count].id, steps: 3 })),
      });

      const mark = await rebuildAll();

      expect(await db.client.extendedNetwork.count({ where: { userId: { in: bare.map((user) => user.id) } } })).toBe(0);

      // It went back to the queue at least once: a step, not a retry, since
      // the drain would have failed on a retry.
      const queue = extendedNetworkQueue();
      const events = await (await queue.client).xrange(queue.toKey('events'), mark.id, '+');
      const steps = events.filter(([, fields]) => fields[0] === 'event' && fields[1] === 'delayed');
      expect(steps.length).toBeGreaterThanOrEqual(1);
    } finally {
      await db.client.user.deleteMany({ where: { username: { startsWith: `e2e-batch-${token}-` } } });
    }
  });

  // The foreign keys cascade, so no row names a deleted user. A pair whose
  // only path went through them keeps its row until the daily rebuild:
  // deleting a user queues no rebuild. The deleted user is a bare `users` row:
  // a registered one also has a profile, preferences and roles, whose own keys
  // refuse the delete.
  it('removes every row naming a deleted user (#497)', async () => {
    const [a, c] = await users(2);
    const token = randomUUID().slice(0, 8);
    const b = {
      user: await db.client.user.create({ data: { username: `e2e-${token}`, email: `${token}@example.test` } }),
    };
    await befriend(db.client, a, b);
    await befriend(db.client, b, c);
    await rebuildAll();
    expect(await stepsFrom(a)).toEqual({ [b.user.id]: 1, [c.user.id]: 2 });

    await db.client.user.delete({ where: { id: b.user.id } });

    expect(
      await db.client.extendedNetwork.count({ where: { OR: [{ userId: b.user.id }, { otherUserId: b.user.id }] } }),
    ).toBe(0);
    expect(await stepsFrom(a)).toEqual({ [c.user.id]: 2 });
  });
});
