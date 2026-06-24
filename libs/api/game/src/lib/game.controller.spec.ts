import type { PaginationQueryDto } from '@bge/shared';
import { createTestingModuleWithDb } from '@bge/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { firstValueFrom } from 'rxjs';
import type { CreateGameDto, UpdateGameDto } from './dto';
import { GameController } from './game.controller';
import { GameService } from './game.service';

const PAGINATION: PaginationQueryDto = { offset: 0, limit: 20 };

describe('GameController', () => {
  let controller: GameController;
  let gameService: GameService;
  let cacheService: Cache;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      providers: [
        {
          provide: GameService,
          useValue: {
            getGames: jest.fn().mockResolvedValue([]),
            getGame: jest.fn().mockResolvedValue({ id: 'game-1' }),
            createGame: jest.fn().mockResolvedValue({ id: 'game-1' }),
            updateGame: jest.fn().mockResolvedValue({ id: 'game-1' }),
            deleteGame: jest.fn().mockResolvedValue({ id: 'game-1' }),
          },
        },
      ],
    });

    gameService = module.get(GameService);
    cacheService = module.get(CACHE_MANAGER);

    controller = new GameController(gameService, cacheService);
  });

  afterEach(() => jest.clearAllMocks());

  it('getGames forwards only pagination', async () => {
    await firstValueFrom(controller.getGames(PAGINATION));
    expect(gameService.getGames).toHaveBeenCalledWith(PAGINATION);
  });

  it('getGame forwards only the id', async () => {
    await firstValueFrom(controller.getGameById('game-1'));
    expect(gameService.getGame).toHaveBeenCalledWith('game-1');
  });

  it('create forwards the dto', async () => {
    await firstValueFrom(controller.createGame({ title: 'X' } as CreateGameDto));
    expect(gameService.createGame).toHaveBeenCalledWith({ title: 'X' });
  });

  it('update forwards id and dto', async () => {
    await firstValueFrom(controller.updateGame('game-1', { title: 'New' } as UpdateGameDto));
    expect(gameService.updateGame).toHaveBeenCalledWith('game-1', { title: 'New' });
  });

  it('delete forwards only the id', async () => {
    await firstValueFrom(controller.deleteGame('game-1'));
    expect(gameService.deleteGame).toHaveBeenCalledWith('game-1');
  });
});
