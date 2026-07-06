import { GameMedium, GameRemovalReason } from '@bge/database';
import { firstValueFrom } from 'rxjs';
import { GameCollectionController } from './game-collection.controller';
import { GameCollectionService } from './game-collection.service';

const PAGINATION = { offset: 0, limit: 20 } as never;

describe('GameCollectionController (delegation)', () => {
  let controller: GameCollectionController;
  let service: jest.Mocked<
    Pick<GameCollectionService, 'listOwn' | 'listForUser' | 'getById' | 'addToCollection' | 'update' | 'remove'>
  >;

  beforeEach(() => {
    service = {
      listOwn: jest.fn().mockResolvedValue([]),
      listForUser: jest.fn().mockResolvedValue([]),
      getById: jest.fn().mockResolvedValue({ id: 'gc-1' }),
      addToCollection: jest.fn().mockResolvedValue({ id: 'gc-1' }),
      update: jest.fn().mockResolvedValue({ id: 'gc-1' }),
      remove: jest.fn().mockResolvedValue({ id: 'gc-1' }),
    };
    controller = new GameCollectionController(service as never);
  });

  afterEach(() => jest.clearAllMocks());

  it('getOwnCollection forwards the query and wraps the result', async () => {
    const result = await firstValueFrom(controller.getOwnCollection(PAGINATION));
    expect(service.listOwn).toHaveBeenCalledWith(PAGINATION);
    expect(result).toEqual({ collections: [] });
  });

  it('getUserCollection forwards the user id and query', async () => {
    await firstValueFrom(controller.getUserCollection('user-2', PAGINATION));
    expect(service.listForUser).toHaveBeenCalledWith('user-2', PAGINATION);
  });

  it('getCollectionEntry forwards the id', async () => {
    const result = await firstValueFrom(controller.getCollectionEntry('gc-1'));
    expect(service.getById).toHaveBeenCalledWith('gc-1');
    expect(result).toEqual({ collection: { id: 'gc-1' } });
  });

  it('addToCollection forwards the dto', async () => {
    const dto = { platformGameId: 'pg-1', medium: GameMedium.Physical };
    const result = await firstValueFrom(controller.addToCollection(dto));
    expect(service.addToCollection).toHaveBeenCalledWith(dto);
    expect(result).toMatchObject({ collection: { id: 'gc-1' }, message: expect.any(String) });
  });

  it('updateCollectionEntry forwards id and dto', async () => {
    await firstValueFrom(controller.updateCollectionEntry('gc-1', { quantity: 2 }));
    expect(service.update).toHaveBeenCalledWith('gc-1', { quantity: 2 });
  });

  it('removeFromCollection forwards id and reason query', async () => {
    await firstValueFrom(controller.removeFromCollection('gc-1', { reason: GameRemovalReason.Sold }));
    expect(service.remove).toHaveBeenCalledWith('gc-1', { reason: GameRemovalReason.Sold });
  });
});
