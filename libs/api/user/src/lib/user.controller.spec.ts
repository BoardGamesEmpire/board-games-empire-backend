import { AuthService, type AuthUser } from '@bge/auth';
import { Action, ResourceType } from '@bge/database';
import { AbilityService, CHECK_POLICIES_KEY, PoliciesGuard, type AppAbility } from '@bge/permissions';
import { ListScopeNotComposedError } from '@bge/shared';
import { createMockAbilityService, createTestingModuleWithDb, MOCK_ACTING_USER_ID } from '@bge/testing';
import { ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import { UserSearchQueryDto } from './dto';
import { UserController } from './user.controller';
import { UserService } from './user.service';

const searchQuery = (init: Partial<UserSearchQueryDto> = {}) =>
  plainToInstance(UserSearchQueryDto, { q: 'ada', ...init }, { enableImplicitConversion: true });

describe('UserController', () => {
  let controller: UserController;
  let service: jest.Mocked<Pick<UserService, 'searchUsers'>>;
  let auth: jest.Mocked<Pick<AuthService, 'findUserById'>>;
  let abilityService: ReturnType<typeof createMockAbilityService>;

  beforeEach(async () => {
    service = { searchUsers: jest.fn().mockResolvedValue({ rows: [], total: 0 }) };
    auth = { findUserById: jest.fn() };
    abilityService = createMockAbilityService();

    const { module } = await createTestingModuleWithDb({
      overrideGuards: [PoliciesGuard],
      providers: [
        { provide: UserService, useValue: service },
        { provide: AuthService, useValue: auth },
        { provide: AbilityService, useValue: abilityService },
      ],
      controllers: [UserController],
    });

    controller = module.get(UserController);
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });

  it("answers /me with the acting user's own row, without the sign-in provider's picture (#695)", async () => {
    const me = { id: MOCK_ACTING_USER_ID, name: 'ada', image: 'https://provider.example/a.png' } as AuthUser;
    auth.findUserById.mockResolvedValue(me);

    await expect(firstValueFrom(controller.me())).resolves.toStrictEqual({
      user: { id: MOCK_ACTING_USER_ID, name: 'ada' },
    });
    expect(auth.findUserById).toHaveBeenCalledWith(MOCK_ACTING_USER_ID);
  });

  it('answers /me with no user when the row is gone', async () => {
    auth.findUserById.mockResolvedValue(null);

    await expect(firstValueFrom(controller.me())).resolves.toStrictEqual({ user: null });
  });

  it('searches as the acting user, never as a caller-supplied id', async () => {
    const query = searchQuery();

    await firstValueFrom(controller.search(query));

    expect(service.searchUsers).toHaveBeenCalledWith(MOCK_ACTING_USER_ID, query);
  });

  // The search leaves its caller out, which means nothing without a user, and
  // the refusal must not soften into a page of everyone.
  it('refuses an actor with no user behind it before searching', () => {
    abilityService.getActingUserId.mockImplementation(() => {
      throw new ForbiddenException();
    });

    expect(() => controller.search(searchQuery())).toThrow(ForbiddenException);
    expect(service.searchUsers).not.toHaveBeenCalled();
  });

  // The rows are users and each carries its profile's columns, so the gate
  // asks for both types.
  it('gates the search on read:User and read:UserProfile', () => {
    const handlers = Reflect.getMetadata(CHECK_POLICIES_KEY, UserController.prototype.search) as
      | Array<(ability: AppAbility) => boolean>
      | undefined;
    expect(handlers).toHaveLength(2);

    const can = jest.fn().mockReturnValue(true);
    for (const handler of handlers ?? []) {
      handler({ can } as unknown as AppAbility);
    }

    expect(can.mock.calls).toEqual([
      [Action.read, ResourceType.User],
      [Action.read, ResourceType.UserProfile],
    ]);
  });

  // The service composes the `User` scope; the envelope is where the guard
  // checks for it. Built inside a request with nothing composed, this
  // envelope must fail, naming the type.
  it('builds its envelope under the User scope guard', async () => {
    const envelope = ClsServiceManager.getClsService().runWith({}, () =>
      firstValueFrom(controller.search(searchQuery())),
    );

    await expect(envelope).rejects.toThrow(ListScopeNotComposedError);
    await expect(envelope).rejects.toThrow(`intrinsic scope for '${ResourceType.User}'`);
  });

  it('wraps the rows in the paginated envelope, echoing the requested page', async () => {
    service.searchUsers.mockResolvedValue({ rows: [{ id: 'u-1' }], total: 25 } as never);

    const response = await firstValueFrom(controller.search(searchQuery({ page: 2, limit: 10 })));

    expect(response).toEqual({
      users: [{ id: 'u-1' }],
      pagination: { page: 2, limit: 10, total: 25, totalPages: 3, hasMore: true },
    });
  });

  // D-372-5: the body used to carry `search: query.q` beside the rows. The
  // caller sent `q`, and a per-endpoint third field is how a shared envelope
  // stops being shared — so the response is rows plus `pagination`, nothing else.
  it('no longer echoes the search term in the body', async () => {
    const response = await firstValueFrom(controller.search(searchQuery()));

    expect(Object.keys(response as object).sort()).toEqual(['pagination', 'users']);
  });
});
