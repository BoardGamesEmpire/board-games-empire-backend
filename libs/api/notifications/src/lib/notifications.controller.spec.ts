import { NotificationsService } from '@bge/notifications-service';
import { AbilityService, PoliciesGuard } from '@bge/permissions';
import { createMockAbilityService, createTestingModuleWithDb, MOCK_ACTING_USER_ID } from '@bge/testing';
import { MarkReadDto } from './dto/mark-read.dto';
import { NotificationsController } from './notifications.controller';

describe('NotificationsController', () => {
  let controller: NotificationsController;
  let notifications: jest.Mocked<Pick<NotificationsService, 'getUnread' | 'markRead' | 'markAllRead'>>;

  beforeEach(async () => {
    notifications = {
      getUnread: jest.fn().mockResolvedValue([]),
      markRead: jest.fn().mockResolvedValue(undefined),
      markAllRead: jest.fn().mockResolvedValue(undefined),
    };

    const { module } = await createTestingModuleWithDb({
      controllers: [NotificationsController],
      overrideGuards: [PoliciesGuard],
      providers: [
        { provide: NotificationsService, useValue: notifications },
        { provide: AbilityService, useValue: createMockAbilityService() },
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
});
