import type { PaginationQueryDto } from '@bge/shared';
import { createTestingModuleWithDb, paginationQuery } from '@bge/testing';
import { firstValueFrom } from 'rxjs';
import type { CreateGameDto, UpdateGameDto } from './dto';
import { GameController } from './game.controller';
import { GameService } from './game.service';

const PAGINATION: PaginationQueryDto = paginationQuery({ limit: 20 });

describe('GameController', () => {
  let controller: GameController;
  let gameService: GameService;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      providers: [
        {
          provide: GameService,
          useValue: {
            getGames: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
            getGame: jest.fn().mockResolvedValue({ id: 'game-1' }),
            createGame: jest.fn().mockResolvedValue({ id: 'game-1' }),
            updateGame: jest.fn().mockResolvedValue({ id: 'game-1' }),
            deleteGame: jest.fn().mockResolvedValue({ id: 'game-1' }),
          },
        },
      ],
    });

    gameService = module.get(GameService);

    controller = new GameController(gameService);
  });

  afterEach(() => jest.clearAllMocks());

  it('getGames forwards only pagination', async () => {
    await firstValueFrom(controller.getGames(PAGINATION));
    expect(gameService.getGames).toHaveBeenCalledWith(PAGINATION);
  });

  // #372: the controller is where the rows the service read become the wire
  // envelope, so the echoed paging has to come from the query it was given —
  // not from a page size the service re-defaulted for itself.
  it('wraps the rows in the paginated envelope, echoing the requested page', async () => {
    (gameService.getGames as jest.Mock).mockResolvedValue({ rows: [{ id: 'game-1' }], total: 31 });

    const response = await firstValueFrom(controller.getGames(paginationQuery({ page: 2, limit: 10 })));

    expect(response).toEqual({
      games: [{ id: 'game-1' }],
      pagination: { page: 2, limit: 10, total: 31, totalPages: 4, hasMore: true },
    });
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
