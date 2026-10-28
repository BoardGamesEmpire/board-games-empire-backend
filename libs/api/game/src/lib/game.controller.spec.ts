import { ResourceType } from '@bge/database';
import { ListScopeNotComposedError, RandomSampleQueryDto } from '@bge/shared';
import { boundPageQuery, createTestingModuleWithDb, type PageQueryInit } from '@bge/testing';
import { ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import { ListGamesQueryDto, type CreateGameDto, type UpdateGameDto } from './dto';
import { GameController } from './game.controller';
import { GameService } from './game.service';

const listQuery = (init: PageQueryInit<ListGamesQueryDto> = {}) => boundPageQuery(ListGamesQueryDto, init);

const QUERY = listQuery({ limit: 20 });

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
            getRandomGames: jest.fn().mockResolvedValue([]),
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

  // #959: the sort travels inside the query, so the service reads the page and
  // the order from the one object the pipe validated.
  it('getGames forwards the query, sort included', async () => {
    const query = listQuery({ limit: 20, sort: 'newest' });
    await firstValueFrom(controller.getGames(query));
    expect(gameService.getGames).toHaveBeenCalledWith(query);
  });

  // #372: the controller is where the rows the service read become the wire
  // envelope, so the echoed paging has to come from the query it was given —
  // not from a page size the service re-defaulted for itself.
  it('wraps the rows in the paginated envelope, echoing the requested page', async () => {
    (gameService.getGames as jest.Mock).mockResolvedValue({ rows: [{ id: 'game-1' }], total: 31 });

    const response = await firstValueFrom(controller.getGames(listQuery({ page: 2, limit: 10 })));

    expect(response).toEqual({
      games: [{ id: 'game-1' }],
      pagination: { page: 2, limit: 10, total: 31, totalPages: 4, hasMore: true },
    });
  });

  // The service composes the `Game` scope; the envelope is where the guard
  // checks for it. Built inside a request with nothing composed, this envelope
  // must fail. An `Unscoped` envelope would pass and switch the
  // guard off for the route.
  // The name is asserted too: an envelope naming another swept type would also
  // fail, for the wrong reason.
  it('builds its envelope under the Game scope guard', async () => {
    const envelope = ClsServiceManager.getClsService().runWith({}, () => firstValueFrom(controller.getGames(QUERY)));

    await expect(envelope).rejects.toThrow(ListScopeNotComposedError);
    await expect(envelope).rejects.toThrow(`intrinsic scope for '${ResourceType.Game}'`);
  });

  describe('getRandomGames (#961)', () => {
    const SAMPLE = Object.assign(new RandomSampleQueryDto(), { size: 3 });

    // Routes match in the order they are declared, so below `:id` the word
    // `random` would reach getGameById as a game id.
    it('declares random above :id, so random is never read as a game id', () => {
      const methods = Object.getOwnPropertyNames(GameController.prototype);

      expect(methods.indexOf('getRandomGames')).toBeGreaterThan(-1);
      expect(methods.indexOf('getRandomGames')).toBeLessThan(methods.indexOf('getGameById'));
    });

    it('forwards only the query', async () => {
      await firstValueFrom(controller.getRandomGames(SAMPLE));

      expect(gameService.getRandomGames).toHaveBeenCalledWith(SAMPLE);
    });

    it('wraps the sample as { games }', async () => {
      const games = [{ id: 'game-1', title: 'Catan', thumbnail: null, description: null }];
      (gameService.getRandomGames as jest.Mock).mockResolvedValue(games);

      await expect(firstValueFrom(controller.getRandomGames(SAMPLE))).resolves.toEqual({ games });
    });

    // The service composes the `Game` scope; the response is where the guard
    // checks for it, as the list's envelope does.
    it('builds the sample under the Game scope guard', async () => {
      const response = ClsServiceManager.getClsService().runWith({}, () =>
        firstValueFrom(controller.getRandomGames(SAMPLE)),
      );

      await expect(response).rejects.toThrow(ListScopeNotComposedError);
      await expect(response).rejects.toThrow(`intrinsic scope for '${ResourceType.Game}'`);
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
