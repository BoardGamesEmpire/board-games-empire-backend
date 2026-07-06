import { FriendshipStatus } from '@bge/database';
import { firstValueFrom } from 'rxjs';
import { FriendshipController } from './friendship.controller';
import { FriendshipService } from './friendship.service';

const PAGINATION = { offset: 0, limit: 10 } as never;

describe('FriendshipController (delegation)', () => {
  let controller: FriendshipController;
  let service: jest.Mocked<
    Pick<FriendshipService, 'create' | 'listForUser' | 'listIncomingRequests' | 'respond' | 'remove'>
  >;

  beforeEach(() => {
    service = {
      create: jest.fn().mockResolvedValue({ id: 'f-1' }),
      listForUser: jest.fn().mockResolvedValue([]),
      listIncomingRequests: jest.fn().mockResolvedValue([]),
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

  it('respond forwards id and status', async () => {
    await firstValueFrom(controller.respond('f-1', { status: FriendshipStatus.Accepted }));
    expect(service.respond).toHaveBeenCalledWith('f-1', FriendshipStatus.Accepted);
  });

  it('remove forwards only the id', async () => {
    await firstValueFrom(controller.remove('f-1'));
    expect(service.remove).toHaveBeenCalledWith('f-1');
  });
});
