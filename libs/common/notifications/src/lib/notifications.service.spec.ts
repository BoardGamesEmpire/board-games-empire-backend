import { createTestingModuleWithDb } from '@bge/testing';
import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  let service: NotificationsService;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      providers: [NotificationsService],
    });

    service = module.get(NotificationsService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });
});
