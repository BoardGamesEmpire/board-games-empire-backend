import { Action, ResourceType } from '@bge/database';
import { CHECK_POLICIES_KEY, PoliciesGuard, type AppAbility } from '@bge/permissions';
import { createTestingModuleWithDb } from '@bge/testing';
import { firstValueFrom } from 'rxjs';
import { makeProfileRow } from './profile-row.fixture';
import { toProfileView } from './profile-view';
import { UserProfileController } from './user-profile.controller';
import { UserProfileService } from './user-profile.service';

/** The `@CheckPolicies` handlers on a controller method, each called with a recording `can`. */
const policyChecksOf = (method: object) => {
  const handlers = Reflect.getMetadata(CHECK_POLICIES_KEY, method) as
    | Array<(ability: AppAbility) => boolean>
    | undefined;
  const can = jest.fn().mockReturnValue(true);
  for (const handler of handlers ?? []) {
    handler({ can } as unknown as AppAbility);
  }

  return can.mock.calls;
};

describe('UserProfileController', () => {
  let controller: UserProfileController;
  let service: jest.Mocked<Pick<UserProfileService, 'getProfile' | 'getOwnProfile'>>;

  const view = toProfileView(makeProfileRow(), false);

  beforeEach(async () => {
    service = {
      getProfile: jest.fn().mockResolvedValue(view),
      getOwnProfile: jest.fn().mockResolvedValue(view),
    };

    const { module } = await createTestingModuleWithDb({
      overrideGuards: [PoliciesGuard],
      providers: [{ provide: UserProfileService, useValue: service }],
      controllers: [UserProfileController],
    });

    controller = module.get(UserProfileController);
  });

  afterEach(() => jest.clearAllMocks());

  it('reads /me/profile as the acting user, never a caller-supplied id', async () => {
    await expect(firstValueFrom(controller.getOwnProfile())).resolves.toEqual({ profile: view });

    expect(service.getOwnProfile).toHaveBeenCalledWith();
    expect(service.getProfile).not.toHaveBeenCalled();
  });

  it('reads /:id/profile for the user named', async () => {
    await expect(firstValueFrom(controller.getProfile('u2'))).resolves.toEqual({ profile: view });

    expect(service.getProfile).toHaveBeenCalledWith('u2');
  });

  it('checks read UserProfile on both reads', () => {
    expect(policyChecksOf(UserProfileController.prototype.getOwnProfile)).toEqual([
      [Action.read, ResourceType.UserProfile],
    ]);
    expect(policyChecksOf(UserProfileController.prototype.getProfile)).toEqual([
      [Action.read, ResourceType.UserProfile],
    ]);
  });
});
