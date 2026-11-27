import { NotificationType } from '@bge/database';
import type { GameImportedPayload } from '@bge/notifications-service';
import type { Actors, SessionActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import request from 'supertest';
import type { Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import type { NotificationPageWire } from './notification-wire';
import { notificationPage, unreadCount, unreadNotifications } from './notification-wire';

/**
 * The notification history list, `GET /api/notifications`, and the unread
 * count beside it (#1597). The list keeps a notification after it is marked
 * read, newest first, and pages by keyset: the cursor is the last row's
 * (`createdAt`, `id`), so a notification written between two page reads
 * shifts nothing, rows sharing one `createdAt` split across a page boundary
 * cleanly, and a cursor whose row is gone still marks where the next page
 * starts.
 *
 * Rows are written straight to the table, as in the authorization spec: only
 * the server's own workers create notifications. Where order matters each
 * row names its `createdAt`, since `@default(now())` is stamped by the app
 * and two rows written in one millisecond would tie.
 *
 * A cursor is only ever taken from a response's `nextCursor`. The decoder
 * refuses any cursor that doesn't re-encode exactly, so one built by hand
 * here could be refused for its spelling rather than for what it names.
 */
describe('notification history', () => {
  const baseUrl = requireBaseUrl(process.env);
  const LIST_PATH = '/api/notifications';
  const UNREAD_PATH = '/api/notifications/unread';
  const COUNT_PATH = '/api/notifications/unread/count';
  const MARK_READ_PATH = '/api/notifications/mark-read';

  /** The instant the arranged rows count from; any fixed past time does. */
  const BASE = Date.parse('2026-11-27T10:00:00.000Z');
  const at = (seconds: number) => new Date(BASE + seconds * 1000);

  const PAYLOAD = {
    gameId: 'game-1',
    gameTitle: 'A game',
    thumbnail: null,
    jobId: 'job-1',
    batchId: 'batch-1',
  } satisfies GameImportedPayload;

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  /** One unread notification for `recipient`, stamped `createdAt` when given. */
  async function notify(recipient: SessionActor, createdAt?: Date): Promise<string> {
    const { id } = await db.client.notification.create({
      data: { userId: recipient.user.id, type: NotificationType.GameImported, payload: PAYLOAD, createdAt },
      select: { id: true },
    });

    return id;
  }

  /** `count` notifications for `recipient`, one a second from BASE, their ids oldest first. */
  async function notifyAt(recipient: SessionActor, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let second = 0; second < count; second += 1) {
      ids.push(await notify(recipient, at(second)));
    }

    return ids;
  }

  function list(reader: Caller, query: Record<string, string | number> = {}) {
    return request(baseUrl).get(LIST_PATH).query(query).set(reader.headers);
  }

  async function page(reader: Caller, query: Record<string, string | number> = {}): Promise<NotificationPageWire> {
    const response = await list(reader, query).expect(200);

    return notificationPage(response, `GET ${LIST_PATH}`);
  }

  /** The next page after `previous`, which must have said there is one. */
  async function nextPage(reader: Caller, previous: NotificationPageWire, limit: number) {
    expect(previous.nextCursor).toEqual(expect.any(String));

    return page(reader, { limit, cursor: previous.nextCursor ?? '' });
  }

  const idsOf = ({ notifications }: NotificationPageWire) => notifications.map(({ id }) => id);

  it('keeps a notification marked read in the list, with read true and its readAt (#1597)', async () => {
    const reader = await actors.user();
    const id = await notify(reader);

    // Read before the write, as a client does: a cached list would repeat
    // this body after the mark-read.
    const before = await page(reader);
    expect(before.notifications).toEqual([expect.objectContaining({ id, read: false, readAt: null })]);

    await request(baseUrl)
      .post(MARK_READ_PATH)
      .set(reader.headers)
      .send({ notificationIds: [id] })
      .expect(200);

    const after = await page(reader);
    expect(after.notifications).toEqual([expect.objectContaining({ id, read: true, readAt: expect.any(String) })]);
    const [{ readAt }] = after.notifications;
    expect(new Date(readAt ?? '').toISOString()).toBe(readAt);
  });

  it('lists newest first, read and unread together (#1597)', async () => {
    const reader = await actors.user();
    const [oldest, middle, newest] = await notifyAt(reader, 3);
    await db.client.notification.update({ where: { id: middle }, data: { read: true, readAt: at(10) } });

    const first = await page(reader);

    expect(first.notifications.map(({ id, read, createdAt }) => ({ id, read, createdAt }))).toEqual([
      { id: newest, read: false, createdAt: at(2).toISOString() },
      { id: middle, read: true, createdAt: at(1).toISOString() },
      { id: oldest, read: false, createdAt: at(0).toISOString() },
    ]);
    // No limit asked for: the default page size, echoed.
    expect(first).toEqual(expect.objectContaining({ limit: 25, hasMore: false, nextCursor: null }));
  });

  it('pages without repeating or skipping a row when a notification is written between two page reads (#1597)', async () => {
    const reader = await actors.user();
    const newestFirst = (await notifyAt(reader, 5)).reverse();

    const first = await page(reader, { limit: 2 });
    const newer = await notify(reader, at(60));
    const second = await nextPage(reader, first, 2);
    const third = await nextPage(reader, second, 2);

    expect([...idsOf(first), ...idsOf(second), ...idsOf(third)]).toEqual(newestFirst);
    expect(third).toEqual(expect.objectContaining({ hasMore: false, nextCursor: null }));

    const fresh = await page(reader, { limit: 2 });
    expect(idsOf(fresh)).toEqual([newer, newestFirst[0]]);
  });

  it('pages across rows that share one createdAt (#1597)', async () => {
    // `createMany` stamps a whole batch with one app-side timestamp, so a page
    // boundary can fall inside it. Only the id tie-break keeps the next page
    // from skipping the batch's remaining rows or repeating its first.
    const reader = await actors.user();
    const createdAt = at(0);
    await db.client.notification.createMany({
      data: Array.from({ length: 5 }, () => ({
        userId: reader.user.id,
        type: NotificationType.GameImported,
        payload: PAYLOAD,
        createdAt,
      })),
    });
    const created = await db.client.notification.findMany({ where: { userId: reader.user.id }, select: { id: true } });

    const first = await page(reader, { limit: 2 });
    const second = await nextPage(reader, first, 2);
    const third = await nextPage(reader, second, 2);
    const ids = [...idsOf(first), ...idsOf(second), ...idsOf(third)];

    expect([idsOf(first).length, idsOf(second).length, idsOf(third).length]).toEqual([2, 2, 1]);
    expect(new Set(ids).size).toBe(5);
    expect([...ids].sort()).toEqual(created.map(({ id }) => id).sort());
    expect(third).toEqual(expect.objectContaining({ hasMore: false, nextCursor: null }));
  });

  it('continues from a cursor whose row was deleted since (#1597)', async () => {
    // The cursor names a position, not a row: a notification deleted after
    // the page that ended on it, by a cascade now or a retention sweep later,
    // still marks where the next page starts.
    const reader = await actors.user();
    const newestFirst = (await notifyAt(reader, 5)).reverse();

    const first = await page(reader, { limit: 2 });
    expect(idsOf(first)).toEqual(newestFirst.slice(0, 2));
    await db.client.notification.delete({ where: { id: newestFirst[1] } });

    const second = await nextPage(reader, first, 2);
    expect(idsOf(second)).toEqual(newestFirst.slice(2, 4));
  });

  it('ends with nextCursor null and hasMore false (#1597)', async () => {
    const reader = await actors.user();
    const newestFirst = (await notifyAt(reader, 3)).reverse();

    // A page that holds exactly the rows left is the last: no empty page after it.
    const exact = await page(reader, { limit: 3 });
    expect(idsOf(exact)).toEqual(newestFirst);
    expect(exact).toEqual(expect.objectContaining({ limit: 3, hasMore: false, nextCursor: null }));

    const first = await page(reader, { limit: 2 });
    expect(first).toEqual(expect.objectContaining({ hasMore: true, nextCursor: expect.any(String) }));
    const last = await nextPage(reader, first, 2);
    expect(idsOf(last)).toEqual(newestFirst.slice(2));
    expect(last).toEqual(expect.objectContaining({ limit: 2, hasMore: false, nextCursor: null }));
  });

  // The last two are well-formed base64url JSON that Postgres would refuse if
  // the read reached it: a NUL in text, and a year it has no such date for.
  // The decoder refuses both, so each is the client's 400, never a 500.
  const encode = (position: readonly [string, string]) => Buffer.from(JSON.stringify(position)).toString('base64url');

  it.each([
    ['not a cursor', 'garbage'],
    ['empty', ''],
    ['an id holding a NUL', encode(['2026-11-27T10:00:00.000Z', 'a\u0000b'])],
    ['a date in year 0', encode(['0000-01-01T00:00:00.000Z', 'n1'])],
  ])('refuses a malformed cursor with 400: %s (#1597)', async (_label, cursor) => {
    const reader = await actors.user();
    await notify(reader);

    const response = await list(reader, { cursor });

    expectErrorEnvelope(response, { status: 400, code: null });
    expect((response.body as { message?: unknown }).message).toEqual(
      expect.arrayContaining([expect.stringMatching(/^cursor /)]),
    );
  });

  it("lists none of another user's notifications (#1597)", async () => {
    const [reader, other] = await Promise.all([actors.user(), actors.user()]);
    const own = await notify(reader);
    await notify(other);

    expect(idsOf(await page(reader))).toEqual([own]);
  });

  it('counts unread notifications past the 100 that /unread returns (#1597)', async () => {
    const [reader, other] = await Promise.all([actors.user(), actors.user()]);
    // A read row carries the readAt a mark-read writes with it (#903).
    const row = (read: boolean) => ({
      userId: reader.user.id,
      type: NotificationType.GameImported,
      payload: PAYLOAD,
      read,
      readAt: read ? new Date() : null,
    });
    await db.client.notification.createMany({ data: [...Array.from({ length: 101 }, () => row(false)), row(true)] });
    await notify(other);

    const count = await request(baseUrl).get(COUNT_PATH).set(reader.headers).expect(200);
    expect(unreadCount(count, `GET ${COUNT_PATH}`)).toBe(101);

    const unread = await request(baseUrl).get(UNREAD_PATH).set(reader.headers).expect(200);
    expect(unreadNotifications(unread, `GET ${UNREAD_PATH}`)).toHaveLength(100);
  });
});
