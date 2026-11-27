import { AbilityService, PoliciesGuard } from '@bge/permissions';
import { CACHE_RESPONSE_KEY, encodeKeysetCursor } from '@bge/shared';
import type { MockAbilityService } from '@bge/testing';
import { createMockAbilityService, createTestingModuleWithDb, MOCK_ACTING_USER_ID } from '@bge/testing';
import { ForbiddenException } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Http } from '@status/codes';
import { ListNotificationsQueryDto } from './dto/list-notifications.query.dto';
import { MarkReadDto } from './dto/mark-read.dto';
import { NotificationsController } from './notifications.controller';
import { UserNotificationsService } from './user-notifications.service';

describe('NotificationsController', () => {
  let controller: NotificationsController;
  let notifications: jest.Mocked<
    Pick<UserNotificationsService, 'getUnread' | 'list' | 'countUnread' | 'markRead' | 'markAllRead'>
  >;
  let abilityService: MockAbilityService;

  beforeEach(async () => {
    notifications = {
      getUnread: jest.fn().mockResolvedValue([]),
      list: jest.fn().mockResolvedValue({ rows: [], nextCursor: null }),
      countUnread: jest.fn().mockResolvedValue(0),
      markRead: jest.fn().mockResolvedValue(undefined),
      markAllRead: jest.fn().mockResolvedValue(undefined),
    };
    abilityService = createMockAbilityService();

    const { module } = await createTestingModuleWithDb({
      controllers: [NotificationsController],
      overrideGuards: [PoliciesGuard],
      providers: [
        { provide: UserNotificationsService, useValue: notifications },
        { provide: AbilityService, useValue: abilityService },
      ],
    });

    controller = module.get(NotificationsController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });

  it("reads the acting user's unread notifications", async () => {
    await controller.getUnread();

    expect(notifications.getUnread).toHaveBeenCalledWith(MOCK_ACTING_USER_ID);
  });

  describe('list', () => {
    const position = { createdAt: new Date('2026-11-27T12:00:00.000Z'), id: 'n-9' };

    function queryFor(params: { cursor?: string; limit?: number }): ListNotificationsQueryDto {
      return Object.assign(new ListNotificationsQueryDto(), params);
    }

    it('reads the first page for the acting user at the default page size (#1597)', async () => {
      const response = await controller.list(queryFor({}));

      expect(notifications.list).toHaveBeenCalledWith(MOCK_ACTING_USER_ID, { after: undefined, pageSize: 25 });
      expect(response).toEqual({
        notifications: [],
        pagination: { limit: 25, hasMore: false, nextCursor: null },
      });
    });

    it('passes the decoded cursor position and the page size through (#1597)', async () => {
      await controller.list(queryFor({ cursor: encodeKeysetCursor(position), limit: 10 }));

      expect(notifications.list).toHaveBeenCalledWith(MOCK_ACTING_USER_ID, { after: position, pageSize: 10 });
    });

    it('returns the rows under notifications with the next cursor in pagination (#1597)', async () => {
      const rows = [{ id: 'n-9', createdAt: position.createdAt }];
      notifications.list.mockResolvedValue({ rows: rows as never, nextCursor: 'next-page' });

      const response = await controller.list(queryFor({ limit: 1 }));

      expect(response.notifications).toBe(rows);
      expect(response.pagination).toEqual({ limit: 1, hasMore: true, nextCursor: 'next-page' });
    });
  });

  it("counts the acting user's unread notifications (#1597)", async () => {
    notifications.countUnread.mockResolvedValue(3);

    await expect(controller.countUnread()).resolves.toEqual({ count: 3 });
    expect(notifications.countUnread).toHaveBeenCalledWith(MOCK_ACTING_USER_ID);
  });

  // The list and the count change with every notification a worker writes and
  // every mark-read, as `/unread` does; a cached body would repeat the old one
  // for the whole TTL (#530).
  it.each(['getUnread', 'list', 'countUnread'] as const)('%s stays out of the response cache (#530)', (route) => {
    expect(Reflect.getMetadata(CACHE_RESPONSE_KEY, NotificationsController.prototype[route])).toBeUndefined();
  });

  it('keeps the unread count and the unread list on distinct paths (#1597)', () => {
    expect(Reflect.getMetadata('path', NotificationsController.prototype.getUnread)).toBe('unread');
    expect(Reflect.getMetadata('path', NotificationsController.prototype.countUnread)).toBe('unread/count');
    expect(Reflect.getMetadata('path', NotificationsController.prototype.list)).toBe('/');
  });

  it("marks the acting user's notifications read", async () => {
    await controller.markRead(Object.assign(new MarkReadDto(), { notificationIds: ['n-1'] }));
    await controller.markAllRead();

    expect(notifications.markRead).toHaveBeenCalledWith(MOCK_ACTING_USER_ID, ['n-1']);
    expect(notifications.markAllRead).toHaveBeenCalledWith(MOCK_ACTING_USER_ID);
  });

  // Neither route creates anything: they mark rows that exist. Nest's default
  // for a POST is 201.
  it.each(['markRead', 'markAllRead'] as const)(
    '%s answers 200: it marks rows that exist and creates none (#584)',
    (route) => {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, NotificationsController.prototype[route])).toBe(Http.Ok);
    },
  );

  // Each route's subject is the user behind the actor. An actor with no user
  // has no notifications to ask about, and the refusal must not soften into
  // an empty tray.
  it('refuses an actor with no user behind it on every route, before the service is asked', async () => {
    abilityService.getActingUserId.mockImplementation(() => {
      throw new ForbiddenException();
    });

    await expect(controller.getUnread()).rejects.toThrow(ForbiddenException);
    await expect(controller.list(new ListNotificationsQueryDto())).rejects.toThrow(ForbiddenException);
    await expect(controller.countUnread()).rejects.toThrow(ForbiddenException);
    await expect(controller.markRead(Object.assign(new MarkReadDto(), { notificationIds: ['n-1'] }))).rejects.toThrow(
      ForbiddenException,
    );
    await expect(controller.markAllRead()).rejects.toThrow(ForbiddenException);

    expect(notifications.getUnread).not.toHaveBeenCalled();
    expect(notifications.list).not.toHaveBeenCalled();
    expect(notifications.countUnread).not.toHaveBeenCalled();
    expect(notifications.markRead).not.toHaveBeenCalled();
    expect(notifications.markAllRead).not.toHaveBeenCalled();
  });
});
