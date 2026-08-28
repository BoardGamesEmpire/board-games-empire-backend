import { FriendshipStatus } from '@bge/database';
import { DefaultPaginationQueryDto } from '@bge/shared';
import { paginationQuery } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { firstValueFrom } from 'rxjs';
import { ListFriendshipsQueryDto } from './dto';
import { FriendshipController } from './friendship.controller';
import { FriendshipService } from './friendship.service';

const PAGINATION = paginationQuery({ limit: 10 });

describe('FriendshipController (delegation)', () => {
  let controller: FriendshipController;
  let service: jest.Mocked<
    Pick<FriendshipService, 'create' | 'listForUser' | 'listIncomingRequests' | 'respond' | 'remove'>
  >;

  beforeEach(() => {
    service = {
      create: jest.fn().mockResolvedValue({ id: 'f-1' }),
      listForUser: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
      listIncomingRequests: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
      respond: jest.fn().mockResolvedValue({ id: 'f-1' }),
      remove: jest.fn().mockResolvedValue({ id: 'f-1' }),
    };
    controller = new FriendshipController(service as never);
  });

  afterEach(() => jest.clearAllMocks());

  it('create forwards the dto', async () => {
    await firstValueFrom(controller.create({ addresseeId: 'user-2' }));
    expect(service.create).toHaveBeenCalledWith({ addresseeId: 'user-2' });
  });

  it('list forwards the query', async () => {
    await firstValueFrom(controller.list(PAGINATION));
    expect(service.listForUser).toHaveBeenCalledWith(PAGINATION);
  });

  it('listRequests forwards the query', async () => {
    await firstValueFrom(controller.listRequests(PAGINATION));
    expect(service.listIncomingRequests).toHaveBeenCalledWith(PAGINATION);
  });

  // #372: the two reads are different resource keys on the same envelope, and
  // crossing them would hand a client the wrong array name for the rows it got.
  it('wraps each read under its own resource key', async () => {
    service.listForUser.mockResolvedValue({ rows: [{ id: 'f-1' }], total: 3 } as never);
    service.listIncomingRequests.mockResolvedValue({ rows: [{ id: 'f-2' }], total: 1 } as never);

    const friendships = await firstValueFrom(controller.list(paginationQuery({ page: 2, limit: 2 })));
    const requests = await firstValueFrom(controller.listRequests(PAGINATION));

    expect(friendships).toEqual({
      friendships: [{ id: 'f-1' }],
      pagination: { page: 2, limit: 2, total: 3, totalPages: 2, hasMore: false },
    });
    expect(requests).toEqual({
      requests: [{ id: 'f-2' }],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1, hasMore: false },
    });
  });

  /**
   * `?status=` on `/friendships/requests` used to bind through
   * `ListFriendshipsQueryDto` and be silently ignored — Swagger advertised it,
   * the pipe accepted it, and the caller got Pending rows whatever they asked
   * for. Binding the status-less DTO makes it a 400 under the global pipe's
   * `forbidNonWhitelisted`, which is the plugin-unit-list rule from #354.
   *
   * Two halves, because either alone can pass while the contract is broken: the
   * route has to bind a DTO with no `status`, and that DTO has to be one the
   * whitelist actually rejects `status` on.
   */
  describe('the requests route rejects a status filter rather than ignoring it', () => {
    /** The class Nest will bind `@Query()` to, as the emitted metadata records it. */
    const boundQueryDto = () =>
      (
        Reflect.getMetadata('design:paramtypes', FriendshipController.prototype, 'listRequests') as
          | [new () => object]
          | undefined
      )?.[0];

    it('binds a query DTO that does not declare status', () => {
      expect(boundQueryDto()).toBe(DefaultPaginationQueryDto);
    });

    it('fails whitelist validation when status is supplied', async () => {
      const dto = plainToInstance(DefaultPaginationQueryDto, { status: FriendshipStatus.Accepted });

      const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

      expect(errors.map((error) => error.property)).toContain('status');
    });

    it('still accepts a status filter on the wide list', async () => {
      const dto = plainToInstance(ListFriendshipsQueryDto, { status: FriendshipStatus.Accepted });

      const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

      expect(errors).toEqual([]);
    });
  });

  it('respond forwards id and status', async () => {
    await firstValueFrom(controller.respond('f-1', { status: FriendshipStatus.Accepted }));
    expect(service.respond).toHaveBeenCalledWith('f-1', FriendshipStatus.Accepted);
  });

  it('remove forwards only the id', async () => {
    await firstValueFrom(controller.remove('f-1'));
    expect(service.remove).toHaveBeenCalledWith('f-1');
  });
});
