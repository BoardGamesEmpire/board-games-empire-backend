import { NotificationsServiceModule } from '@bge/notifications-service';
import { PoliciesGuard } from '@bge/permissions';
import { createTestingModuleWithDb } from '@bge/testing';
import { NotificationsController } from './notifications.controller';

describe('NotificationsController', () => {
  let controller: NotificationsController;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      imports: [NotificationsServiceModule],
      controllers: [NotificationsController],
      overrideGuards: [PoliciesGuard],
    });

    controller = module.get(NotificationsController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });
});
