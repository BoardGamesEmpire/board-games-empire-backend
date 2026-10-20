import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { Action, ContentType, PlatformType, ResourceType } from '@bge/database';
import { gameListScope } from '@bge/game';
import { t } from '@bge/i18n';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import {
  createMockAbilityService,
  createTestingModuleWithDb,
  MOCK_ACTING_USER_ID,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import * as proto from '@boardgamesempire/proto-gateway';
import { ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { EMPTY, firstValueFrom } from 'rxjs';
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

describe('GameSearchService', () => {
  let service: GameSearchService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;
  let compose: jest.SpyInstance;
  let coordinator: { searchGames: jest.Mock };

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([READ]);
    coordinator = { searchGames: jest.fn() };

    const ctx = await createTestingModuleWithDb({
      providers: [
        GameSearchService,
        // The REAL composer, over the mocked ability service, so the where
        // clauses asserted below are the merge the search actually runs.
        ScopeComposer,
        { provide: AbilityService, useValue: abilityService },
        { provide: GatewayCoordinatorClientService, useValue: coordinator },
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

    it('takes only a scope that localSearchScope built', async () => {
      // A type test: `game-search:typecheck` enforces the directive (an unused
      // one is itself a compile error), and jest only confirms it runs. A
      // hand-built `where` reads outside the scope; `{}` reads every game,
      // private and deleted alike (#472).
      // @ts-expect-error -- a plain `where` is not a LocalSearchScope
      await service.queryLocalGames('brass', {}, 10, 5, {});
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
  });
});
