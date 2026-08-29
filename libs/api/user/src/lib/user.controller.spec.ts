import { PoliciesGuard } from '@bge/permissions';
import { createTestingModuleWithDb } from '@bge/testing';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { plainToInstance } from 'class-transformer';
import { firstValueFrom } from 'rxjs';
import { UserSearchQueryDto } from './dto';
import { UserController } from './user.controller';
import { UserService } from './user.service';

const searchQuery = (init: Partial<UserSearchQueryDto> = {}) =>
  plainToInstance(UserSearchQueryDto, { q: 'ada', ...init }, { enableImplicitConversion: true });

const session = { user: { id: 'me' } } as never;

describe('UserController', () => {
  let controller: UserController;
  let service: jest.Mocked<Pick<UserService, 'searchUsers'>>;

  beforeEach(async () => {
    service = { searchUsers: jest.fn().mockResolvedValue({ rows: [], total: 0 }) };

    const { module } = await createTestingModuleWithDb({
      overrideGuards: [AuthGuard, PoliciesGuard],
      providers: [{ provide: UserService, useValue: service }],
      controllers: [UserController],
    });

    controller = module.get(UserController);
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });

  it('searches as the session user, never as a caller-supplied id', async () => {
    const query = searchQuery();

    await firstValueFrom(controller.search(query, session));

    expect(service.searchUsers).toHaveBeenCalledWith('me', query);
  });

  it('wraps the rows in the paginated envelope, echoing the requested page', async () => {
    service.searchUsers.mockResolvedValue({ rows: [{ id: 'u-1' }], total: 25 } as never);

    const response = await firstValueFrom(controller.search(searchQuery({ page: 2, limit: 10 }), session));

    expect(response).toEqual({
      users: [{ id: 'u-1' }],
      pagination: { page: 2, limit: 10, total: 25, totalPages: 3, hasMore: true },
    });
  });

  // D-372-5: the body used to carry `search: query.q` beside the rows. The
  // caller sent `q`, and a per-endpoint third field is how a shared envelope
  // stops being shared — so the response is rows plus `pagination`, nothing else.
  it('no longer echoes the search term in the body', async () => {
    const response = await firstValueFrom(controller.search(searchQuery(), session));

    expect(Object.keys(response as object).sort()).toEqual(['pagination', 'users']);
  });
});
