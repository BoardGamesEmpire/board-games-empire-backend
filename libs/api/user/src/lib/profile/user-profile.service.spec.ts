import { Action, ResourceType } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import {
  createMockAbilityService,
  createTestingModuleWithDb,
  MOCK_ACTING_USER_ID,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { makeProfileRow } from './profile-row.fixture';
import { PROFILE_SELECT } from './profile-view';
import { UserProfileService } from './user-profile.service';

/** Stands in for the caller's `UserProfile` read conditions, so the assertions can tell them from the lookup's own. */
const READ_COND = { id: 'within-the-read-conditions' };

describe('UserProfileService', () => {
  let service: UserProfileService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([READ_COND]);

    const ctx = await createTestingModuleWithDb({
      providers: [UserProfileService, { provide: AbilityService, useValue: abilityService }],
    });

    db = ctx.db;
    service = ctx.module.get(UserProfileService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getProfile', () => {
    it("reads through the caller's UserProfile read conditions", async () => {
      db.userProfile.findUnique.mockResolvedValue(makeProfileRow({ userId: 'u2' }) as never);

      await service.getProfile('u2');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.UserProfile, Action.read);
      expect(db.userProfile.findUnique).toHaveBeenCalledWith({
        where: { userId: 'u2', AND: [READ_COND] },
        select: PROFILE_SELECT,
      });
    });

    // One answer for both, as an event's read gives: a 403 would tell the
    // caller the profile exists and is shut to them (#819).
    it('answers 404 when the caller cannot read the profile, or it does not exist', async () => {
      db.userProfile.findUnique.mockResolvedValue(null);

      await expect(service.getProfile('u2')).rejects.toThrow(NotFoundException);
    });

    it("serves the owner-only fields only when the profile is the caller's own", async () => {
      db.userProfile.findUnique.mockResolvedValue(makeProfileRow({ userId: 'u2' }) as never);
      await expect(service.getProfile('u2')).resolves.not.toHaveProperty('dietaryRestrictions');

      db.userProfile.findUnique.mockResolvedValue(makeProfileRow({ userId: MOCK_ACTING_USER_ID }) as never);
      await expect(service.getProfile(MOCK_ACTING_USER_ID)).resolves.toHaveProperty('dietaryRestrictions', 'No nuts');
    });

    // An actor with no user behind it owns no profile. It reads what its
    // rules admit, without the owner-only fields, rather than being refused.
    it('serves an actor with no user the shared fields alone', async () => {
      abilityService.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException();
      });
      db.userProfile.findUnique.mockResolvedValue(makeProfileRow({ userId: 'u2' }) as never);

      const view = await service.getProfile('u2');

      expect(view).toHaveProperty('username', 'ada');
      expect(view).not.toHaveProperty('reach');
    });
  });

  describe('getOwnProfile', () => {
    it("reads the acting user's own profile, owner-only fields included", async () => {
      db.userProfile.findUnique.mockResolvedValue(makeProfileRow({ userId: MOCK_ACTING_USER_ID }) as never);

      const view = await service.getOwnProfile();

      expect(db.userProfile.findUnique).toHaveBeenCalledWith({
        where: { userId: MOCK_ACTING_USER_ID, AND: [READ_COND] },
        select: PROFILE_SELECT,
      });
      expect(view).toHaveProperty('isSearchable', true);
    });
  });
});
