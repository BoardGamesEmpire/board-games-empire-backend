import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { Action, ContentType, PlatformType, ResourceType } from '@bge/database';
import { gameListScope, GameService } from '@bge/game';
import { t } from '@bge/i18n';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import {
  createMockAbilityService,
  createTestingModuleWithDb,
  makeGame,
  MOCK_ACTING_USER_ID,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import * as proto from '@boardgamesempire/proto-gateway';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { concat, EMPTY, firstValueFrom, NEVER, of, throwError } from 'rxjs';
import { ExpansionsQueryDto } from './dto/expansions-query.dto';
import { SearchQueryDto } from './dto/search-query.dto';
import { GameSearchService } from './game-search.service';

const READ = { id: 'sentinel-read-condition' };

/** The list scope of the acting user, clipped by their ceiling. */
const COMPOSED = { ...gameListScope(MOCK_ACTING_USER_ID), AND: [READ] };

const TITLE_BRASS = { title: { contains: 'brass', mode: 'insensitive' } };

/** What the global pipe hands the controller: an instance, so `pageSize` resolves. */
const localOnly = (overrides: Partial<SearchQueryDto> = {}): SearchQueryDto =>
  plainToInstance(SearchQueryDto, { query: 'brass', includeExternal: false, ...overrides });

const userlessActor = () => {
  throw new ForbiddenException(t('errors.actor_context.not_user_attributable', { kind: 'plugin' }));
};

/** One primed ability that answers whether its actor may ask the DataGateways (#1076). */
const abilityThatMayAskDataGateways = (may: boolean) => ({
  can: jest.fn(
    (action: Action, subject: unknown) => may && action === Action.read && subject === ResourceType.DataGatewaySearch,
  ),
});

describe('GameSearchService', () => {
  let service: GameSearchService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;
  let compose: jest.SpyInstance;
  let coordinator: { searchGames: jest.Mock; fetchExpansions: jest.Mock };
  let gameService: { readDataGatewayLinks: jest.Mock };

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([READ]);
    abilityService.getCurrentAbilities.mockReturnValue([abilityThatMayAskDataGateways(true)] as never);
    coordinator = { searchGames: jest.fn(), fetchExpansions: jest.fn() };
    gameService = { readDataGatewayLinks: jest.fn() };

    const ctx = await createTestingModuleWithDb({
      providers: [
        GameSearchService,
        // The REAL composer, over the mocked ability service, so the where
        // clauses asserted below are the merge the search actually runs.
        ScopeComposer,
        { provide: AbilityService, useValue: abilityService },
        { provide: GatewayCoordinatorClientService, useValue: coordinator },
        { provide: GameService, useValue: gameService },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(GameSearchService);
    compose = jest.spyOn(ctx.module.get(ScopeComposer), 'compose');
    db.game.findMany.mockResolvedValue([]);
  });

  afterEach(() => jest.clearAllMocks());

  /**
   * #513. Both local searches used to take the caller's ceiling as their
   * answer set, so staff found every private game on the server. They now
   * declare the set `GET /games` lists, and the ceiling only clips it.
   */
  describe('localSearchScope', () => {
    it('asks the composer for the list scope of the acting user, as `GET /games` does', () => {
      service.localSearchScope();

      expect(compose).toHaveBeenCalledWith(ResourceType.Game, Action.read, gameListScope(MOCK_ACTING_USER_ID));
    });

    it('answers with the composed clause, the ceiling clipping its scope rather than supplying it', () => {
      expect(service.localSearchScope()).toEqual(COMPOSED);
      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Game, Action.read);
    });

    // PROVISIONAL (#395), as for `GET /games`: half the scope is the caller's
    // own games, which has no meaning for an actor with no user behind it.
    it('refuses an actor kind with no user behind it', () => {
      abilityService.getActingUserId.mockImplementation(userlessActor);

      let refusal: unknown;
      try {
        service.localSearchScope();
      } catch (error) {
        refusal = error;
      }

      // The read's own key, not the write-flavoured one `getActingUserId` throws.
      expect(refusal).toBeInstanceOf(ForbiddenException);
      expect((refusal as ForbiddenException).getResponse()).toEqual(t('common.forbidden.access'));
    });
  });

  describe('queryLocalGames', () => {
    it('matches the title only within the scope it is given', async () => {
      // The title filter narrows the scope; it never widens it.
      await service.queryLocalGames('brass', service.localSearchScope(), 10, 5, {});

      expect(db.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { AND: [COMPOSED, TITLE_BRASS] }, take: 10, skip: 5 }),
      );
    });

    it('narrows within the scope by the filter: content type, and the platform types of the game’s platforms', async () => {
      await service.queryLocalGames('brass', service.localSearchScope(), 10, 5, {
        platformTypes: [PlatformType.Tabletop, PlatformType.Portable],
        contentTypes: [ContentType.Expansion],
      });

      expect(db.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [
              COMPOSED,
              TITLE_BRASS,
              { contentType: { in: [ContentType.Expansion] } },
              {
                platformGames: {
                  some: { platform: { platformType: { in: [PlatformType.Tabletop, PlatformType.Portable] } } },
                },
              },
            ],
          },
        }),
      );
    });

    it('leaves an axis whose list is empty unfiltered', async () => {
      await service.queryLocalGames('brass', service.localSearchScope(), 10, 5, {
        platformTypes: [],
        contentTypes: [],
      });

      expect(db.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { AND: [COMPOSED, TITLE_BRASS] } }),
      );
    });

    // A search result carries play time as the game catalog stores it, in
    // minutes (#869), and leaves out a time the game doesn't have.
    it('carries each game’s play time in minutes', async () => {
      db.game.findMany.mockResolvedValue([
        makeGame({ minPlayTime: 60, maxPlayTime: 120 }),
        makeGame({ id: 'g2', minPlayTime: 45, maxPlayTime: null }),
      ]);

      const [both, minimumOnly] = await service.queryLocalGames('brass', service.localSearchScope(), 10, 0, {});

      expect(db.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ select: expect.objectContaining({ minPlayTime: true, maxPlayTime: true }) }),
      );
      expect(both).toMatchObject({ minPlayTime: 60, maxPlayTime: 120 });
      expect(minimumOnly).toMatchObject({ minPlayTime: 45 });
      expect(minimumOnly?.maxPlayTime).toBeUndefined();
    });

    it('takes only a scope that localSearchScope built', async () => {
      // A type test: `game-search:typecheck` enforces the directive (an unused
      // one is itself a compile error), and jest only confirms it runs. A
      // hand-built `where` reads outside the scope; `{}` reads every game,
      // private and deleted alike (#472).
      // @ts-expect-error -- a plain `where` is not a LocalSearchScope
      await service.queryLocalGames('brass', {}, 10, 5, {});
    });
  });

  /**
   * #1076. Asking the DataGateways sends the query upstream on the server's
   * credentials, so it takes `read:data_gateway:search`, which an
   * anonymous user does not hold. It is checked before either half starts:
   * a refusal is an authorization failure, never "no games found".
   */
  describe('search (REST): asking the DataGateways', () => {
    const withDataGateways = () => plainToInstance(SearchQueryDto, { query: 'brass' });

    it('refuses an actor who may not ask the DataGateways, before either half starts', () => {
      abilityService.getCurrentAbilities.mockReturnValue([abilityThatMayAskDataGateways(false)] as never);

      expect(() => service.search(withDataGateways())).toThrow(ForbiddenException);
      expect(coordinator.searchGames).not.toHaveBeenCalled();
      expect(compose).not.toHaveBeenCalled();
    });

    it('refuses with a message of its own, not the generic refusal', () => {
      abilityService.getCurrentAbilities.mockReturnValue([abilityThatMayAskDataGateways(false)] as never);

      const refusal = (() => {
        try {
          service.search(withDataGateways());
        } catch (error: unknown) {
          return error;
        }

        return undefined;
      })();

      expect((refusal as ForbiddenException).getResponse()).toEqual(t('errors.game_search.data_gateways_forbidden'));
    });

    it('refuses when any primed ability refuses, as an API key and its owner are checked together', () => {
      abilityService.getCurrentAbilities.mockReturnValue([
        abilityThatMayAskDataGateways(true),
        abilityThatMayAskDataGateways(false),
      ] as never);

      expect(() => service.search(withDataGateways())).toThrow(ForbiddenException);
    });

    it('asks the DataGateways for an actor who may', async () => {
      coordinator.searchGames.mockReturnValue(EMPTY);

      await firstValueFrom(service.search(withDataGateways()));

      expect(coordinator.searchGames).toHaveBeenCalledTimes(1);
    });

    it('still searches the game catalog alone for an actor who may not ask the DataGateways', async () => {
      abilityService.getCurrentAbilities.mockReturnValue([abilityThatMayAskDataGateways(false)] as never);

      await firstValueFrom(service.search(localOnly()));

      expect(db.game.findMany).toHaveBeenCalledTimes(1);
      expect(coordinator.searchGames).not.toHaveBeenCalled();
    });
  });

  describe('search (REST)', () => {
    it('reads within the composed scope', async () => {
      await firstValueFrom(service.search(localOnly()));

      expect(db.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { AND: [COMPOSED, TITLE_BRASS] } }),
      );
    });

    it('surfaces a failure to build the scope rather than answering with no games', async () => {
      // The local half swallows a failed query to `[]`. A missing ability
      // context is a different failure, and an empty result would hide it.
      const unprimed = new Error('ability context not primed');
      abilityService.getCurrentResourceConditions.mockImplementation(() => {
        throw unprimed;
      });

      expect(() => service.search(localOnly())).toThrow(unprimed);
      expect(db.game.findMany).not.toHaveBeenCalled();
    });

    it('refuses an actor kind with no user behind it rather than answering with no games', () => {
      abilityService.getActingUserId.mockImplementation(userlessActor);

      expect(() => service.search(localOnly())).toThrow(ForbiddenException);
      expect(db.game.findMany).not.toHaveBeenCalled();
    });

    it("takes the DTO's page size, 20 when the caller names none", async () => {
      await firstValueFrom(service.search(localOnly()));

      expect(db.game.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 20, skip: 0 }));
    });

    it('takes the limit and offset the caller sent', async () => {
      await firstValueFrom(service.search(localOnly({ limit: 5, offset: 10 })));

      expect(db.game.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5, skip: 10 }));
    });

    // An external-only search reads no game row, so it is not refused for
    // having no user behind it.
    it('builds no scope when the local half is skipped', () => {
      service.search(localOnly({ includeLocal: false }));

      expect(compose).not.toHaveBeenCalled();
      expect(abilityService.getActingUserId).not.toHaveBeenCalled();
    });

    it('narrows the local half by the filter the caller sent', async () => {
      await firstValueFrom(service.search(localOnly({ contentTypes: [ContentType.BaseGame] })));

      expect(db.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { AND: [COMPOSED, TITLE_BRASS, { contentType: { in: [ContentType.BaseGame] } }] },
        }),
      );
    });

    it('sends the coordinator the filter in proto terms, and none when the caller sent none', async () => {
      coordinator.searchGames.mockReturnValue(EMPTY);
      const external = (overrides: Partial<SearchQueryDto>) =>
        plainToInstance(SearchQueryDto, { query: 'brass', includeLocal: false, ...overrides });

      await firstValueFrom(
        service.search(external({ platformTypes: [PlatformType.Portable], contentTypes: [ContentType.DLC] })),
      );
      await firstValueFrom(service.search(external({})));

      expect(coordinator.searchGames).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          filter: {
            platformTypes: [proto.PlatformType.PLATFORM_TYPE_PORTABLE],
            contentTypes: [proto.ContentType.CONTENT_TYPE_DLC],
          },
        }),
      );
      expect(coordinator.searchGames).toHaveBeenNthCalledWith(2, expect.objectContaining({ filter: undefined }));
    });

    // #869: both ranges reach the coordinator as the caller sent them, and
    // narrow the search in the game catalog by the same rules.
    it('sends the coordinator the player-count and play-time ranges, and narrows the search in the game catalog by them', async () => {
      coordinator.searchGames.mockReturnValue(EMPTY);

      await firstValueFrom(
        service.search(
          plainToInstance(SearchQueryDto, {
            query: 'brass',
            playerCountMin: 5,
            playTimeMax: 90,
            playTimeIncludeUnknown: true,
          }),
        ),
      );

      expect(coordinator.searchGames).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: {
            platformTypes: [],
            contentTypes: [],
            playerCount: { min: 5 },
            playTime: { max: 90, includeUnknown: true },
          },
        }),
      );
      expect(db.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [
              COMPOSED,
              TITLE_BRASS,
              { minPlayers: { lte: 5 }, maxPlayers: { gte: 5 } },
              {
                OR: [
                  { OR: [{ maxPlayTime: { lte: 90 } }, { maxPlayTime: null, minPlayTime: { lte: 90 } }] },
                  { minPlayTime: null, maxPlayTime: null },
                ],
              },
            ],
          },
        }),
      );
    });
  });

  /**
   * #1067. A base game's expansions at its DataGateways, named by a
   * DataGateway and the game's external ID there, or by the game's ID on this
   * server, which stands for each of its DataGateway links. Answered in
   * search's response shape.
   */
  describe('fetchExpansions', () => {
    const { RESULT_STATUS_RESULT: RESULT, RESULT_STATUS_SOURCE_DONE: SOURCE_DONE } = proto.ResultStatus;
    const { RESULT_STATUS_UNAVAILABLE: UNAVAILABLE } = proto.ResultStatus;

    const expansionsQuery = (fields: Record<string, unknown>): ExpansionsQueryDto =>
      plainToInstance(ExpansionsQueryDto, fields);
    const byExternalId = () => expansionsQuery({ gatewayId: 'bgg', externalId: '13', locale: 'en' });
    const byGame = () => expansionsQuery({ gameId: 'game-1' });

    const expansion = (gatewayId: string, externalId: string, title: string): proto.SearchGameResult => ({
      correlationId: 'c1',
      gatewayId,
      status: RESULT,
      game: {
        externalId,
        title,
        contentType: proto.ContentType.CONTENT_TYPE_EXPANSION,
        availablePlatforms: [],
        availableReleases: [],
      },
      inSystem: false,
    });
    const frame = (gatewayId: string, status: proto.ResultStatus): proto.SearchGameResult => ({
      correlationId: 'c1',
      gatewayId,
      status,
    });

    /** What `fn` threw, synchronously. */
    const refusalOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (error: unknown) {
        return error as BadRequestException | ForbiddenException;
      }

      throw new Error('expected a refusal');
    };

    it('refuses an actor who may not ask the DataGateways, before reading anything', () => {
      abilityService.getCurrentAbilities.mockReturnValue([abilityThatMayAskDataGateways(false)] as never);

      for (const dto of [byExternalId(), byGame()]) {
        const refusal = refusalOf(() => service.fetchExpansions(dto));

        expect(refusal).toBeInstanceOf(ForbiddenException);
        expect(refusal.getResponse()).toEqual(t('errors.game_search.data_gateways_forbidden'));
      }
      expect(gameService.readDataGatewayLinks).not.toHaveBeenCalled();
      expect(coordinator.fetchExpansions).not.toHaveBeenCalled();
    });

    it.each([
      ['both forms at once', { gatewayId: 'bgg', externalId: '13', gameId: 'game-1' }],
      ['neither form', {}],
      ['a DataGateway alone', { gatewayId: 'bgg' }],
      ['an external ID alone', { externalId: '13' }],
      ['a game id with an external ID', { gameId: 'game-1', externalId: '13' }],
    ])('refuses %s, with a message saying what to name', (_case, fields) => {
      const refusal = refusalOf(() => service.fetchExpansions(expansionsQuery(fields)));

      expect(refusal).toBeInstanceOf(BadRequestException);
      expect(refusal.getResponse()).toEqual(t('errors.game_search.expansions_target_exactly_one'));
      expect(gameService.readDataGatewayLinks).not.toHaveBeenCalled();
      expect(coordinator.fetchExpansions).not.toHaveBeenCalled();
    });

    it('counts a field sent as null as left out', async () => {
      coordinator.fetchExpansions.mockReturnValue(of(frame('bgg', SOURCE_DONE)));

      await firstValueFrom(
        service.fetchExpansions(expansionsQuery({ gatewayId: 'bgg', externalId: '13', gameId: null })),
      );

      expect(coordinator.fetchExpansions).toHaveBeenCalledTimes(1);
    });

    it('asks the coordinator once for a DataGateway and external ID', async () => {
      coordinator.fetchExpansions.mockReturnValue(
        of(expansion('bgg', '325', 'Catan: Seafarers'), frame('bgg', SOURCE_DONE)),
      );

      const response = await firstValueFrom(service.fetchExpansions(byExternalId()));

      expect(coordinator.fetchExpansions).toHaveBeenCalledTimes(1);
      expect(coordinator.fetchExpansions).toHaveBeenCalledWith({
        correlationId: response.correlationId,
        gatewayId: 'bgg',
        baseExternalId: '13',
        locale: 'en',
      });
      expect(response.correlationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.resultsBySource).toEqual({
        bgg: [expect.objectContaining({ externalId: '325', title: 'Catan: Seafarers', inSystem: false })],
      });
      expect(gameService.readDataGatewayLinks).not.toHaveBeenCalled();
    });

    it('asks once per DataGateway link of a game, with one correlation id', async () => {
      gameService.readDataGatewayLinks.mockResolvedValue([
        { gatewayId: 'bgg', externalId: '13' },
        { gatewayId: 'igdb', externalId: '740' },
      ]);
      coordinator.fetchExpansions.mockImplementation(({ gatewayId }: { gatewayId: string }) =>
        of(frame(gatewayId, SOURCE_DONE)),
      );

      const response = await firstValueFrom(
        service.fetchExpansions(expansionsQuery({ gameId: 'game-1', locale: 'de' })),
      );

      expect(gameService.readDataGatewayLinks).toHaveBeenCalledWith('game-1');
      expect(coordinator.fetchExpansions.mock.calls.map(([request]) => request)).toEqual([
        { correlationId: response.correlationId, gatewayId: 'bgg', baseExternalId: '13', locale: 'de' },
        { correlationId: response.correlationId, gatewayId: 'igdb', baseExternalId: '740', locale: 'de' },
      ]);
    });

    it('answers an empty result for a game with no DataGateway link, without asking the coordinator', async () => {
      gameService.readDataGatewayLinks.mockResolvedValue([]);

      const response = await firstValueFrom(service.fetchExpansions(byGame()));

      expect(response).toEqual({ correlationId: expect.any(String), resultsBySource: {} });
      expect(coordinator.fetchExpansions).not.toHaveBeenCalled();
    });

    it.each([
      ['404', new NotFoundException('missing')],
      ['403', new ForbiddenException('refused')],
    ])('lets a %s from reading the game through, rather than answering empty', async (_status, refusal) => {
      gameService.readDataGatewayLinks.mockRejectedValue(refusal);

      await expect(firstValueFrom(service.fetchExpansions(byGame()))).rejects.toBe(refusal);
      expect(coordinator.fetchExpansions).not.toHaveBeenCalled();
    });

    it('keeps one DataGateway’s rows when another linked DataGateway is unavailable', async () => {
      gameService.readDataGatewayLinks.mockResolvedValue([
        { gatewayId: 'bgg', externalId: '13' },
        { gatewayId: 'igdb', externalId: '740' },
      ]);
      coordinator.fetchExpansions.mockImplementation(({ gatewayId }: { gatewayId: string }) =>
        gatewayId === 'igdb'
          ? of(frame('igdb', UNAVAILABLE))
          : of(expansion('bgg', '325', 'Catan: Seafarers'), frame('bgg', SOURCE_DONE)),
      );

      const response = await firstValueFrom(service.fetchExpansions(byGame()));

      expect(response.unavailableSources).toEqual(['igdb']);
      expect(response.resultsBySource['bgg']).toEqual([expect.objectContaining({ externalId: '325' })]);
    });

    it('lists an expansion once per DataGateway when the game has two links there', async () => {
      gameService.readDataGatewayLinks.mockResolvedValue([
        { gatewayId: 'bgg', externalId: '13' },
        { gatewayId: 'bgg', externalId: '278' },
      ]);
      coordinator.fetchExpansions.mockImplementation(() =>
        of(expansion('bgg', '325', 'Catan: Seafarers'), frame('bgg', SOURCE_DONE)),
      );

      const response = await firstValueFrom(service.fetchExpansions(byGame()));

      expect(response.resultsBySource['bgg']).toHaveLength(1);
    });

    it('names a DataGateway once when two of the game’s links there are unavailable', async () => {
      gameService.readDataGatewayLinks.mockResolvedValue([
        { gatewayId: 'bgg', externalId: '13' },
        { gatewayId: 'bgg', externalId: '278' },
      ]);
      coordinator.fetchExpansions.mockImplementation(() => of(frame('bgg', UNAVAILABLE)));

      const response = await firstValueFrom(service.fetchExpansions(byGame()));

      expect(response.unavailableSources).toEqual(['bgg']);
    });

    // A failed coordinator call is that DataGateway's answer only: the other
    // links' rows still arrive, and it isn't read as having no expansions.
    it('keeps the other DataGateways’ rows when one link’s coordinator call fails, and lists that one as unavailable', async () => {
      gameService.readDataGatewayLinks.mockResolvedValue([
        { gatewayId: 'bgg', externalId: '13' },
        { gatewayId: 'igdb', externalId: '740' },
      ]);
      coordinator.fetchExpansions.mockImplementation(({ gatewayId }: { gatewayId: string }) =>
        gatewayId === 'igdb'
          ? throwError(() => new Error('14 UNAVAILABLE: connection reset'))
          : of(expansion('bgg', '325', 'Catan: Seafarers'), frame('bgg', SOURCE_DONE)),
      );

      const response = await firstValueFrom(service.fetchExpansions(byGame()));

      expect(response.resultsBySource['bgg']).toEqual([expect.objectContaining({ externalId: '325' })]);
      expect(response.unavailableSources).toEqual(['igdb']);
      expect(response).not.toHaveProperty('errors');
    });

    it('lists the DataGateway as unavailable, not as having no expansions, when the coordinator fails', async () => {
      coordinator.fetchExpansions.mockReturnValue(throwError(() => new Error('coordinator down')));

      const response = await firstValueFrom(service.fetchExpansions(byExternalId()));

      expect(response).toEqual({ correlationId: expect.any(String), resultsBySource: {}, unavailableSources: ['bgg'] });
    });

    // A DataGateway still sending its list at 15 s has sent only part of it,
    // and answers nothing more: the rows it sent are kept, and it's listed as
    // unavailable, so the part doesn't read as the whole list or as "no
    // expansions". One that finished in time isn't.
    describe('at the 15-second deadline', () => {
      beforeEach(() => jest.useFakeTimers());
      afterEach(() => jest.useRealTimers());

      it('lists a DataGateway still sending its list as unavailable, keeping the rows it sent', async () => {
        gameService.readDataGatewayLinks.mockResolvedValue([
          { gatewayId: 'bgg', externalId: '13' },
          { gatewayId: 'igdb', externalId: '740' },
        ]);
        coordinator.fetchExpansions.mockImplementation(({ gatewayId }: { gatewayId: string }) =>
          gatewayId === 'bgg'
            ? concat(of(expansion('bgg', '325', 'Catan: Seafarers')), NEVER)
            : of(expansion('igdb', '741', 'Halo: ODST'), frame('igdb', SOURCE_DONE)),
        );

        const response$ = firstValueFrom(service.fetchExpansions(byGame()));
        await jest.advanceTimersByTimeAsync(15_000);
        const response = await response$;

        expect(response.resultsBySource['bgg']).toEqual([expect.objectContaining({ externalId: '325' })]);
        expect(response.resultsBySource['igdb']).toEqual([expect.objectContaining({ externalId: '741' })]);
        expect(response.unavailableSources).toEqual(['bgg']);
      });

      it('lists a DataGateway that sent nothing by then as unavailable, not as having no expansions', async () => {
        coordinator.fetchExpansions.mockReturnValue(NEVER);

        const response$ = firstValueFrom(service.fetchExpansions(byExternalId()));
        await jest.advanceTimersByTimeAsync(15_000);

        expect(await response$).toEqual({
          correlationId: expect.any(String),
          resultsBySource: {},
          unavailableSources: ['bgg'],
        });
      });
    });
  });

  // #869: the coordinator answers a DataGateway that can't apply a player-count
  // or play-time range with one UNFILTERABLE frame, in place of asking it.
  // Without a note of it, every such DataGateway would read as "no results".
  describe('search (REST): DataGateways a search filter skipped', () => {
    const frame = (gatewayId: string, status: proto.ResultStatus): proto.SearchGameResult => ({
      correlationId: 'c1',
      gatewayId,
      status,
    });

    const externalOnly = () =>
      plainToInstance(SearchQueryDto, { query: 'brass', includeLocal: false, playerCountMin: 5 });

    it('lists a DataGateway answering UNFILTERABLE in unfilterableSources (#869)', async () => {
      coordinator.searchGames.mockReturnValue(of(frame('bgg', proto.ResultStatus.RESULT_STATUS_UNFILTERABLE)));

      const response = await firstValueFrom(service.search(externalOnly()));

      expect(response.unfilterableSources).toEqual(['bgg']);
      expect(response.resultsBySource).not.toHaveProperty('bgg');
    });

    it('keeps a skipped DataGateway apart from the unavailable, and omits the list when none was skipped (#869)', async () => {
      coordinator.searchGames.mockReturnValue(
        of(
          frame('bgg', proto.ResultStatus.RESULT_STATUS_UNFILTERABLE),
          frame('igdb', proto.ResultStatus.RESULT_STATUS_UNAVAILABLE),
          frame('igdb', proto.ResultStatus.RESULT_STATUS_SOURCE_DONE),
        ),
      );

      const mixed = await firstValueFrom(service.search(externalOnly()));

      expect(mixed.unfilterableSources).toEqual(['bgg']);
      expect(mixed.unavailableSources).toEqual(['igdb']);

      coordinator.searchGames.mockReturnValue(of(frame('bgg', proto.ResultStatus.RESULT_STATUS_SOURCE_DONE)));

      const unskipped = await firstValueFrom(service.search(externalOnly()));

      expect(unskipped).not.toHaveProperty('unfilterableSources');
    });
  });

  // #869: a DataGateway's result carries play time in minutes, as the proto
  // sends it, and leaves out a time the DataGateway didn't send.
  describe('mapProtoGame', () => {
    const resultWith = (game: Partial<proto.GameSearchData>): proto.SearchGameResult => ({
      correlationId: 'c1',
      gatewayId: 'gw-1',
      status: proto.ResultStatus.RESULT_STATUS_RESULT,
      game: {
        externalId: 'ext-1',
        title: 'Brass',
        contentType: proto.ContentType.CONTENT_TYPE_BASE_GAME,
        availablePlatforms: [],
        availableReleases: [],
        ...game,
      },
    });

    it('carries the play time a DataGateway sends, in minutes', () => {
      expect(service.mapProtoGame(resultWith({ minPlaytime: 60, maxPlaytime: 120 }))).toMatchObject({
        minPlayTime: 60,
        maxPlayTime: 120,
      });

      const minimumOnly = service.mapProtoGame(resultWith({ minPlaytime: 45 }));

      expect(minimumOnly.minPlayTime).toBe(45);
      expect(minimumOnly.maxPlayTime).toBeUndefined();
    });

    // #862: the coordinator sends each summary as Markdown (#714), and the
    // mapping used to drop it, so neither REST nor the WebSocket carried one.
    it('carries a DataGateway result’s Markdown summary', () => {
      expect(service.mapProtoGame(resultWith({ summary: '**Trade** and build' })).summary).toBe('**Trade** and build');
    });

    it('leaves summary out when the DataGateway sent none', () => {
      expect(service.mapProtoGame(resultWith({})).summary).toBeUndefined();
    });
  });

  describe('search (REST): a DataGateway result’s summary (#862)', () => {
    it('carries the summary in resultsBySource', async () => {
      const frames: proto.SearchGameResult[] = [
        {
          correlationId: 'c1',
          gatewayId: 'bgg',
          status: proto.ResultStatus.RESULT_STATUS_RESULT,
          game: {
            externalId: '13',
            title: 'Catan',
            contentType: proto.ContentType.CONTENT_TYPE_BASE_GAME,
            availablePlatforms: [],
            availableReleases: [],
            summary: '**Trade** and build',
          },
        },
        { correlationId: 'c1', gatewayId: 'bgg', status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE },
      ];
      coordinator.searchGames.mockReturnValue(of(...frames));

      const response = await firstValueFrom(
        service.search(plainToInstance(SearchQueryDto, { query: 'catan', includeLocal: false })),
      );

      expect(response.resultsBySource['bgg'][0].summary).toBe('**Trade** and build');
    });
  });
});
