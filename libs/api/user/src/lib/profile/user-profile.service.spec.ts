import { Action, Prisma, Reach, ResourceType } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import {
  createMockAbilityService,
  createTestingModuleWithDb,
  MOCK_ACTING_USER_ID,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UpdateUserProfileDto } from '../dto/update-user-profile.dto';
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

  describe('updateOwnProfile', () => {
    /** Stands in for the caller's `UserProfile` update conditions. */
    const UPDATE_COND = { id: 'within-the-update-conditions' };

    const edit = (fields: Partial<UpdateUserProfileDto>) => Object.assign(new UpdateUserProfileDto(), fields);

    const recordToUpdateNotFound = () =>
      new Prisma.PrismaClientKnownRequestError('Record to update not found', { code: 'P2025', clientVersion: 'test' });

    beforeEach(() => {
      abilityService.getCurrentResourceConditions.mockImplementation((_type, action) =>
        action === Action.update ? [UPDATE_COND] : [READ_COND],
      );
      db.userProfile.update.mockResolvedValue(makeProfileRow({ userId: MOCK_ACTING_USER_ID }) as never);
    });

    // A write to another user's profile is refused: the write names the
    // caller's own row and nothing else, under their update conditions.
    it("binds the write to the caller's row and their update conditions", async () => {
      await service.updateOwnProfile(edit({ pronouns: 'they/them', reach: Reach.Private, isSearchable: false }));

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.UserProfile, Action.update);
      expect(db.userProfile.update).toHaveBeenCalledWith({
        where: { userId: MOCK_ACTING_USER_ID, AND: [UPDATE_COND] },
        data: { pronouns: 'they/them', reach: Reach.Private, isSearchable: false },
        select: PROFILE_SELECT,
      });
    });

    it('sanitizes the bio as Markdown', async () => {
      await service.updateOwnProfile(edit({ bio: '<script>alert(1)</script>\n\n**Engines** and games' }));

      const bio = db.userProfile.update.mock.calls[0][0].data.bio;
      expect(bio).not.toContain('script');
      expect(bio).toContain('**Engines** and games');
    });

    it('stores a bio that sanitizes to nothing as null', async () => {
      await service.updateOwnProfile(edit({ bio: '<script>alert(1)</script>' }));

      expect(db.userProfile.update.mock.calls[0][0].data).toEqual({ bio: null });
    });

    // Leading spaces can be Markdown: four of them start a code block (#819).
    it('keeps a bio that opens with an indented code block, cutting only blank lines from its start', async () => {
      await service.updateOwnProfile(edit({ bio: '\n\n    rolls 2d6\n\nThen moves.\n' }));

      expect(db.userProfile.update.mock.calls[0][0].data.bio).toBe('    rolls 2d6\n\nThen moves.');
    });

    it('leaves the bio alone when the edit does not name it', async () => {
      await service.updateOwnProfile(edit({ location: 'London' }));

      expect(db.userProfile.update.mock.calls[0][0].data).not.toHaveProperty('bio');
    });

    it('refuses an empty edit with 400', async () => {
      await expect(service.updateOwnProfile(edit({}))).rejects.toThrow(BadRequestException);
      expect(db.userProfile.update).not.toHaveBeenCalled();
    });

    it('answers 403 when the update conditions exclude the row', async () => {
      db.userProfile.update.mockRejectedValue(recordToUpdateNotFound());
      db.userProfile.count.mockResolvedValue(1);

      await expect(service.updateOwnProfile(edit({ location: 'London' }))).rejects.toThrow(ForbiddenException);
    });

    // Provisioning writes the profile after signup, detached from it, so a
    // brand-new user can get here first.
    it('answers 404 when the caller has no profile yet', async () => {
      db.userProfile.update.mockRejectedValue(recordToUpdateNotFound());
      db.userProfile.count.mockResolvedValue(0);

      await expect(service.updateOwnProfile(edit({ location: 'London' }))).rejects.toThrow(NotFoundException);
      expect(db.userProfile.count).toHaveBeenCalledWith({ where: { userId: MOCK_ACTING_USER_ID } });
    });

    it('answers with the profile as its owner sees it', async () => {
      const view = await service.updateOwnProfile(edit({ location: 'London' }));

      expect(view).toMatchObject({ userId: MOCK_ACTING_USER_ID, username: 'ada', dietaryRestrictions: 'No nuts' });
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
