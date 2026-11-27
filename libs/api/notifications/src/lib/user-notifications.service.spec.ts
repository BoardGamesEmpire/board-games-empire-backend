import { Action, NotificationType, ResourceType } from '@bge/database';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import { encodeKeysetCursor, olderThan } from '@bge/shared';
import type { MockAbilityService, MockDatabaseService } from '@bge/testing';
import { createMockAbilityService, createTestingModuleWithDb } from '@bge/testing';
import { UserNotificationsService } from './user-notifications.service';

/** Stands in for the caller's ceiling, so each assertion can tell it from the read's own clauses. */
const COND = { id: 'within-the-ceiling' };

describe('UserNotificationsService', () => {
  let service: UserNotificationsService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([COND]);

    const ctx = await createTestingModuleWithDb({
      providers: [
        UserNotificationsService,
        // The REAL composer over the mocked ability service, so the where-clause
        // assertions below test the merge the read actually depends on.
        ScopeComposer,
        { provide: AbilityService, useValue: abilityService },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(UserNotificationsService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getUnread', () => {
    beforeEach(() => {
      db.notification.findMany.mockResolvedValue([]);
    });

    it('caps the read to the most-recent 100 unread rows', async () => {
      await service.getUnread('user-1');

      expect(db.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'desc' }, take: 100 }),
      );
    });

    // The scope is the user's own unread notifications, and the ceiling only
    // clips it: an API key pinned to one notification lists that one alone.
    it("composes the user's own unread notifications with the caller's read ceiling", async () => {
      await service.getUnread('user-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Notification, Action.read);
      expect(db.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1', read: false, AND: [COND] } }),
      );
    });
  });

  describe('list', () => {
    /** Rows as the read selects them, newest first, one second apart. */
    const rows = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `n-${String(count - index).padStart(3, '0')}`,
        userId: 'user-1',
        type: NotificationType.ImportFailed,
        read: index % 2 === 0,
        readAt: index % 2 === 0 ? new Date(Date.UTC(2026, 10, 27, 13, 0, 0)) : null,
        payload: { error: 'failed' },
        createdAt: new Date(Date.UTC(2026, 10, 27, 12, 0, count - index)),
      }));

    beforeEach(() => {
      db.notification.findMany.mockResolvedValue([]);
    });

    // One extra row tells the read whether a next page exists without a
    // count; the order matches olderThan's tie-break on id (#1597).
    it("composes the user's own notifications with the caller's read ceiling, newest first, one row past the page", async () => {
      await service.list('user-1', { pageSize: 25 });

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Notification, Action.read);
      expect(db.notification.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', AND: [COND] },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 26,
        select: { id: true, type: true, read: true, readAt: true, payload: true, createdAt: true },
      });
    });

    // The cursor clause sits inside the scope's AND, beside the ceiling: it
    // narrows the set, and never replaces the ceiling or escapes it (#1597).
    it('puts the cursor clause beside the ceiling, inside the composed AND', async () => {
      const position = { createdAt: new Date('2026-11-27T12:00:00.000Z'), id: 'n-050' };

      await service.list('user-1', { after: position, pageSize: 25 });

      expect(db.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1', AND: [olderThan(position), COND] } }),
      );
    });

    it('maps readAt through and cuts the extra row into a next cursor', async () => {
      db.notification.findMany.mockResolvedValue(rows(26));

      const page = await service.list('user-1', { pageSize: 25 });

      expect(page.rows).toHaveLength(25);
      expect(page.rows[0]).toEqual({
        id: 'n-026',
        type: NotificationType.ImportFailed,
        read: true,
        readAt: new Date('2026-11-27T13:00:00.000Z'),
        payload: { error: 'failed' },
        createdAt: new Date('2026-11-27T12:00:26.000Z'),
      });
      expect(page.rows[1]).toEqual(expect.objectContaining({ read: false, readAt: null }));
      // The 25th row kept, n-002 at 12:00:02, is where the next page starts.
      expect(page.nextCursor).toBe(
        encodeKeysetCursor({ createdAt: new Date('2026-11-27T12:00:02.000Z'), id: 'n-002' }),
      );
    });

    it('ends on a short page with a null cursor', async () => {
      db.notification.findMany.mockResolvedValue(rows(3));

      const page = await service.list('user-1', { pageSize: 25 });

      expect(page.rows).toHaveLength(3);
      expect(page.nextCursor).toBeNull();
    });
  });

  // The count is uncapped, unlike the /unread list, and composed with the
  // caller's read ceiling as the list is (#1597).
  describe('countUnread', () => {
    it("counts the user's own unread notifications within the caller's read ceiling", async () => {
      db.notification.count.mockResolvedValue(142);

      await expect(service.countUnread('user-1')).resolves.toBe(142);

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Notification, Action.read);
      expect(db.notification.count).toHaveBeenCalledWith({ where: { userId: 'user-1', read: false, AND: [COND] } });
    });
  });

  // #649: an API key scoped to one notification marked every notification of
  // its owner's. Each write now ANDs the caller's `update` ceiling into its
  // filter, so an id outside it is skipped.
  describe('the writes', () => {
    beforeEach(() => {
      db.notification.updateMany.mockResolvedValue({ count: 1 });
    });

    // A notification already read keeps the readAt it has (#903).
    it("markRead keeps to the named unread ids of the user's own, within the caller's update ceiling", async () => {
      await service.markRead('user-1', ['n-1', 'n-2']);

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.Notification,
        Action.update,
      );
      expect(db.notification.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['n-1', 'n-2'] }, userId: 'user-1', read: false, AND: [COND] },
        data: { read: true, readAt: expect.any(Date) },
      });
    });

    it("markAllRead keeps to the user's own unread notifications, within the caller's update ceiling", async () => {
      await service.markAllRead('user-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.Notification,
        Action.update,
      );
      expect(db.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', read: false, AND: [COND] },
        data: { read: true, readAt: expect.any(Date) },
      });
    });
  });
});
