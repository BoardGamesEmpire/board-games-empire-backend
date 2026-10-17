import { AbilityService, PoliciesGuard } from '@bge/permissions';
import {
  createMockAbilityService,
  createTestingModuleWithDb,
  MOCK_ACTING_USER_ID,
  type MockAbilityService,
} from '@bge/testing';
import { ForbiddenException } from '@nestjs/common';
import { MarkReadDto } from './dto/mark-read.dto';
import { NotificationsController } from './notifications.controller';
import { UserNotificationsService } from './user-notifications.service';

describe('NotificationsController', () => {
  let controller: NotificationsController;
  let notifications: jest.Mocked<Pick<UserNotificationsService, 'getUnread' | 'markRead' | 'markAllRead'>>;
  let abilityService: MockAbilityService;

  beforeEach(async () => {
    notifications = {
      getUnread: jest.fn().mockResolvedValue([]),
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

  it("marks the acting user's notifications read", async () => {
    await controller.markRead(Object.assign(new MarkReadDto(), { notificationIds: ['n-1'] }));
    await controller.markAllRead();

    expect(notifications.markRead).toHaveBeenCalledWith(MOCK_ACTING_USER_ID, ['n-1']);
    expect(notifications.markAllRead).toHaveBeenCalledWith(MOCK_ACTING_USER_ID);
  });

  // Each route's subject is the user behind the actor. An actor with no user
  // has no notifications to ask about, and the refusal must not soften into
  // an empty tray.
  it('refuses an actor with no user behind it on every route, before the service is asked', async () => {
    abilityService.getActingUserId.mockImplementation(() => {
      throw new ForbiddenException();
    });

    await expect(controller.getUnread()).rejects.toThrow(ForbiddenException);
    await expect(controller.markRead(Object.assign(new MarkReadDto(), { notificationIds: ['n-1'] }))).rejects.toThrow(
      ForbiddenException,
    );
    await expect(controller.markAllRead()).rejects.toThrow(ForbiddenException);

    expect(notifications.getUnread).not.toHaveBeenCalled();
    expect(notifications.markRead).not.toHaveBeenCalled();
    expect(notifications.markAllRead).not.toHaveBeenCalled();
  });
});
