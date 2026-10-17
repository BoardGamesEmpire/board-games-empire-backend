import { NotificationType, ResourceType } from '@bge/database';
import type { GameImportedPayload } from '@bge/notifications-service';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { mintApiKey, type Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { unreadNotifications } from './notification-wire';

/**
 * A plain user reads and clears their own notifications (#504). The routes'
 * guards ask for `read` and `update` on `Notification`, and until `User` held
 * the own-scoped pair only staff passed the read, through their `read` on
 * `all`, and only the Owner passed the writes.
 *
 * The grant gets a user past the guard. Which rows they reach is each
 * query's own `userId` filter, taken from the actor, with the caller's
 * ceiling ANDed onto it (#517, #649), and the cross-user cases below pin the
 * first half. The ceiling changes no session's rows, since the grant binds the
 * same user; the API-key cases pin it, where a key's scope narrows them.
 *
 * The mark cases read the list before they write, as a client polling it
 * does. A cached list would repeat the rows it held before the write, so
 * without that first read both cases would pass if the route opted into the
 * response cache.
 */
describe('notification authorization', () => {
  const baseUrl = requireBaseUrl(process.env);
  const UNREAD_PATH = '/api/notifications/unread';
  const MARK_READ_PATH = '/api/notifications/mark-read';
  const MARK_ALL_READ_PATH = '/api/notifications/mark-all-read';

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
   * One unread notification for `recipient`, written straight to the table:
   * only the server's own workers create notifications, so there is no route
   * to arrange one through. What it says is not under test here.
   */
  async function notify(recipient: SessionActor): Promise<string> {
    const { id } = await db.client.notification.create({
      data: {
        userId: recipient.user.id,
        type: NotificationType.GameImported,
        payload: {
          gameId: 'game-1',
          gameTitle: 'A game',
          thumbnail: null,
          jobId: 'job-1',
          batchId: 'batch-1',
        } satisfies GameImportedPayload,
      },
      select: { id: true },
    });

    return id;
  }

  async function unreadIds(reader: Caller): Promise<string[]> {
    const response = await request(baseUrl).get(UNREAD_PATH).set(reader.headers).expect(200);

    return unreadNotifications(response, `GET ${UNREAD_PATH}`)
      .map(({ id }) => id)
      .sort();
  }

  async function isRead(notificationId: string): Promise<boolean> {
    const { read } = await db.client.notification.findUniqueOrThrow({
      where: { id: notificationId },
      select: { read: true },
    });

    return read;
  }

  it("lets a plain user read their own unread notifications, and not another user's", async () => {
    const [reader, other] = await Promise.all([actors.user(), actors.user()]);
    const own = await notify(reader);
    const theirs = await notify(other);

    await expect(unreadIds(reader)).resolves.toEqual([own]);
    await expect(unreadIds(other)).resolves.toEqual([theirs]);
  });

  it('lets a plain user mark one of their own notifications read', async () => {
    const reader = await actors.user();
    const marked = await notify(reader);
    const kept = await notify(reader);

    await expect(unreadIds(reader)).resolves.toEqual([marked, kept].sort());

    await request(baseUrl)
      .post(MARK_READ_PATH)
      .set(reader.headers)
      .send({ userId: reader.user.id, notificationIds: [marked] })
      .expect(201);

    await expect(isRead(marked)).resolves.toBe(true);
    await expect(unreadIds(reader)).resolves.toEqual([kept]);
  });

  it("lets a plain user mark all their own notifications read, and leaves another user's unread", async () => {
    const [reader, other] = await Promise.all([actors.user(), actors.user()]);
    await notify(reader);
    await notify(reader);
    const theirs = await notify(other);

    await expect(unreadIds(reader)).resolves.toHaveLength(2);

    await request(baseUrl).post(MARK_ALL_READ_PATH).set(reader.headers).expect(201);

    await expect(unreadIds(reader)).resolves.toEqual([]);
    await expect(isRead(theirs)).resolves.toBe(false);
  });

  it("does not let a user mark another user's notification read, even naming that user in the body", async () => {
    // The body's `userId` is required by the DTO and ignored by the route,
    // which marks by the session's user. Naming the owner is the strongest
    // form of the attempt, and it still reaches nothing: the update matches
    // no row, so the answer is the same 201 an empty mark gets.
    const [owner, other] = await Promise.all([actors.user(), actors.user()]);
    const target = await notify(owner);

    await request(baseUrl)
      .post(MARK_READ_PATH)
      .set(other.headers)
      .send({ userId: owner.user.id, notificationIds: [target] })
      .expect(201);

    await expect(isRead(target)).resolves.toBe(false);
    await expect(unreadIds(owner)).resolves.toEqual([target]);
  });

  /**
   * A key acts as its owner, so each query's `userId` filter admits all of the
   * owner's notifications. The key's scope narrows them only through the
   * ceiling each query ANDs on: without it, a key scoped to one notification
   * read and cleared every one of its owner's (#649).
   */
  describe('through an API key scoped to one notification', () => {
    it('lists only that notification as unread', async () => {
      const owner = await actors.user();
      const scoped = await notify(owner);
      const other = await notify(owner);
      const key = await mintApiKey(baseUrl, db.client, owner, {
        slugs: ['read:notification:own'],
        resourceType: ResourceType.Notification,
        resourceId: scoped,
      });

      // The control: the owner reads both, so the key's page is its scope's.
      await expect(unreadIds(owner)).resolves.toEqual([scoped, other].sort());
      await expect(unreadIds(key)).resolves.toEqual([scoped]);
    });

    const updateKey = (owner: SessionActor, notificationId: string) =>
      mintApiKey(baseUrl, db.client, owner, {
        slugs: ['update:notification:own'],
        resourceType: ResourceType.Notification,
        resourceId: notificationId,
      });

    it('marks read only that notification, when the body names it and another', async () => {
      const owner = await actors.user();
      const scoped = await notify(owner);
      const other = await notify(owner);

      await request(baseUrl)
        .post(MARK_READ_PATH)
        .set((await updateKey(owner, scoped)).headers)
        .send({ userId: owner.user.id, notificationIds: [scoped, other] })
        .expect(201);

      await expect(isRead(scoped)).resolves.toBe(true);
      await expect(isRead(other)).resolves.toBe(false);
    });

    it('marks all read as only that notification, leaving the rest unread', async () => {
      const owner = await actors.user();
      const scoped = await notify(owner);
      const other = await notify(owner);

      await request(baseUrl)
        .post(MARK_ALL_READ_PATH)
        .set((await updateKey(owner, scoped)).headers)
        .expect(201);

      await expect(isRead(scoped)).resolves.toBe(true);
      await expect(isRead(other)).resolves.toBe(false);
    });
  });
});
