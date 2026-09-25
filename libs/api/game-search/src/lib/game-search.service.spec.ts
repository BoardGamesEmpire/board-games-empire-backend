import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { Action, ResourceType } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import {
  createMockAbilityService,
  createTestingModuleWithDb,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { firstValueFrom } from 'rxjs';
import type { SearchQueryDto } from './dto/search-query.dto';
import { GameSearchService } from './game-search.service';

const READ = { id: 'sentinel-read-condition' };

const localOnly = (overrides: Partial<SearchQueryDto> = {}): SearchQueryDto => ({
  query: 'brass',
  offset: 0,
  includeExternal: false,
  ...overrides,
});

describe('GameSearchService', () => {
  let service: GameSearchService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([READ]);

    const ctx = await createTestingModuleWithDb({
      providers: [
        GameSearchService,
        { provide: AbilityService, useValue: abilityService },
        { provide: GatewayCoordinatorClientService, useValue: { searchGames: jest.fn() } },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(GameSearchService);
    db.game.findMany.mockResolvedValue([]);
  });

  afterEach(() => jest.clearAllMocks());

  describe('queryLocalGames', () => {
    it('matches the title only among the games the caller may read', async () => {
      // A private game is its creator's alone (#472). The title filter narrows
      // what the caller may read; it never widens it.
      await service.queryLocalGames('brass', [READ], 10, 5);

      expect(db.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deletedAt: null, title: { contains: 'brass', mode: 'insensitive' }, AND: [READ] },
          take: 10,
          skip: 5,
        }),
      );
    });
  });

  describe('search (REST)', () => {
    it('reads through the current actor’s Game read conditions', async () => {
      await firstValueFrom(service.search(localOnly()));

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Game, Action.read);
      expect(db.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ AND: [READ] }) }),
      );
    });

    it('surfaces a failure to build the conditions rather than answering with no games', async () => {
      // The local half swallows a failed query to `[]`. A missing ability
      // context is a different failure, and an empty result would hide it.
      const unprimed = new Error('ability context not primed');
      abilityService.getCurrentResourceConditions.mockImplementation(() => {
        throw unprimed;
      });

      expect(() => service.search(localOnly())).toThrow(unprimed);
      expect(db.game.findMany).not.toHaveBeenCalled();
    });

    it('builds no conditions when the local half is skipped', () => {
      service.search(localOnly({ includeLocal: false }));

      expect(abilityService.getCurrentResourceConditions).not.toHaveBeenCalled();
    });
  });
});
