import { Action, ResourceType } from '@bge/database';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import {
  createMockAbilityService,
  createTestingModuleWithDb,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
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
});
