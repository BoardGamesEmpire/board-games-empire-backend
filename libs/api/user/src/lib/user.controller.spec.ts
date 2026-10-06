import { AuthService, type AuthUser } from '@bge/auth';
import { AbilityService, PoliciesGuard } from '@bge/permissions';
import { createMockAbilityService, createTestingModuleWithDb, MOCK_ACTING_USER_ID } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
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

  beforeEach(async () => {
    service = { searchUsers: jest.fn().mockResolvedValue({ rows: [], total: 0 }) };
    auth = { findUserById: jest.fn() };

    const { module } = await createTestingModuleWithDb({
      overrideGuards: [PoliciesGuard],
      providers: [
        { provide: UserService, useValue: service },
        { provide: AuthService, useValue: auth },
        { provide: AbilityService, useValue: createMockAbilityService() },
      ],
      controllers: [UserController],
    });

    controller = module.get(UserController);
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });

  it("answers /me with the acting user's own row", async () => {
    const me = { id: MOCK_ACTING_USER_ID, name: 'ada' } as AuthUser;
    auth.findUserById.mockResolvedValue(me);

    await expect(firstValueFrom(controller.me())).resolves.toEqual({ user: me });
    expect(auth.findUserById).toHaveBeenCalledWith(MOCK_ACTING_USER_ID);
  });

  it('searches as the acting user, never as a caller-supplied id', async () => {
    const query = searchQuery();

    await firstValueFrom(controller.search(query));

    expect(service.searchUsers).toHaveBeenCalledWith(MOCK_ACTING_USER_ID, query);
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
