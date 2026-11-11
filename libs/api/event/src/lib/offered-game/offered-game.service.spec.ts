import { Action, ContentType, GameMedium, PlatformType, ResourceType } from '@bge/database';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import {
  createMockAbilityService,
  createTestingModuleWithDb,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { ACTIVE_NOMINATION_STATUSES, lineupStillAhead } from '../attendee/attendance';
import { OfferedGameService } from './offered-game.service';
import type { OfferedGameEntry } from './offered-game.types';

const COND = { id: 'sentinel-condition' };
const NOW = new Date('2026-11-11T12:00:00Z');

/** An offered entry as `OFFERED_GAME_SELECT` reads it, of game `gameId`. */
const entry = (id: string, gameId: string): OfferedGameEntry => ({
  id,
  attendeeId: 'att-1',
  createdAt: new Date('2026-11-01T00:00:00Z'),
  collection: {
    id: `col-${id}`,
    medium: GameMedium.Physical,
    platformGame: {
      id: `pg-${gameId}`,
      image: null,
      thumbnail: null,
      minPlayers: null,
      maxPlayers: null,
      minPlayTime: null,
      maxPlayTime: null,
      platform: { id: 'plat-1', name: 'Tabletop', slug: 'tabletop', platformType: PlatformType.Tabletop },
      game: {
        id: gameId,
        title: `Game ${gameId}`,
        subtitle: null,
        thumbnail: null,
        image: null,
        contentType: ContentType.BaseGame,
        publishYear: null,
        complexity: null,
        minPlayers: 2,
        maxPlayers: 4,
        minPlayTime: 30,
        maxPlayTime: 60,
      },
    },
  },
});

describe('OfferedGameService', () => {
  let service: OfferedGameService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;
  let compose: jest.SpyInstance;

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([COND]);

    const ctx = await createTestingModuleWithDb({
      providers: [
        OfferedGameService,
        // The REAL composer, over the mocked ability service, so the where
        // clauses asserted below are the merge the reads actually run.
        ScopeComposer,
        { provide: AbilityService, useValue: abilityService },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(OfferedGameService);
    compose = jest.spyOn(ctx.module.get(ScopeComposer), 'compose');

    db.gameExpansion.findMany.mockResolvedValue([]);
    db.eventGameNomination.findMany.mockResolvedValue([]);
    db.eventGame.findMany.mockResolvedValue([]);
  });

  afterEach(() => jest.clearAllMocks());

  describe('enrich (#1187)', () => {
    // A link read inside the entry's select would drop a deny-all ceiling and
    // name every base game (#559), so the links are a read of their own, as
    // collection rows read them (#1070).
    it('reads base games once per game, under the live-game read ceiling (#1187)', async () => {
      db.gameExpansion.findMany.mockResolvedValue([
        { expansionGameId: 'game-exp', baseGameId: 'game-base', isStandalone: false },
      ] as never);

      const enriched = await service.enrich(
        [entry('a', 'game-exp'), entry('b', 'game-base'), entry('c', 'game-exp')],
        NOW,
      );

      expect(compose).toHaveBeenCalledWith(ResourceType.Game, Action.read, { deletedAt: null });
      expect(db.gameExpansion.findMany).toHaveBeenCalledTimes(1);
      expect(db.gameExpansion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            expansionGameId: { in: ['game-exp', 'game-base'] },
            baseGame: { is: { deletedAt: null, AND: [COND] } },
          },
        }),
      );
      expect(enriched.map((row) => row.collection.platformGame.game.baseGames)).toEqual([
        [{ gameId: 'game-base', isStandalone: false }],
        [],
        [{ gameId: 'game-base', isStandalone: false }],
      ]);
      expect(enriched.map((row) => row.id)).toEqual(['a', 'b', 'c']);
    });

    // The same two facts the take-back's 409 checks, so a client can tell
    // whether Take back would be refused. A `_count` inside the select would
    // escape the ceilings (#559), so each is a top-level read.
    it('counts open nominations and lineup games still ahead, each under its own read ceiling (#1187)', async () => {
      db.eventGameNomination.findMany.mockResolvedValue([{ suppliedFromId: 'a' }, { suppliedFromId: 'a' }] as never);
      db.eventGame.findMany.mockResolvedValue([{ suppliedById: 'a' }] as never);

      const enriched = await service.enrich([entry('a', 'game-1'), entry('b', 'game-2')], NOW);

      const nominationScope = { suppliedFromId: { in: ['a', 'b'] }, status: { in: ACTIVE_NOMINATION_STATUSES } };
      const lineupScope = { suppliedById: { in: ['a', 'b'] }, ...lineupStillAhead(NOW) };

      expect(compose).toHaveBeenCalledWith(ResourceType.EventGameNomination, Action.read, nominationScope);
      expect(compose).toHaveBeenCalledWith(ResourceType.EventGame, Action.read, lineupScope);
      expect(db.eventGameNomination.findMany).toHaveBeenCalledWith({
        where: { ...nominationScope, AND: [COND] },
        select: { suppliedFromId: true },
      });
      expect(db.eventGame.findMany).toHaveBeenCalledWith({
        where: { ...lineupScope, AND: [COND] },
        select: { suppliedById: true },
      });
      expect(enriched.map((row) => row.supplies)).toEqual([
        { nominations: 2, lineup: 1 },
        { nominations: 0, lineup: 0 },
      ]);
    });

    // 0 would tell a key holding only read on offered games that nothing names
    // the entry, which it can't know.
    it('answers null, not 0, for a count the caller holds no read on (#1187)', async () => {
      abilityService.getCurrentAccess.mockImplementation(((types: readonly string[]) =>
        Object.fromEntries(
          types.map((type) => [type, { [Action.read]: type === ResourceType.EventGameNomination ? 'none' : 'some' }]),
        )) as never);

      const [row] = await service.enrich([entry('a', 'game-1')], NOW);

      expect(row.supplies).toEqual({ nominations: null, lineup: 0 });
      expect(db.eventGameNomination.findMany).not.toHaveBeenCalled();
      expect(db.eventGame.findMany).toHaveBeenCalledTimes(1);
    });

    it('reads nothing for no entries', async () => {
      await expect(service.enrich([], NOW)).resolves.toEqual([]);

      expect(db.gameExpansion.findMany).not.toHaveBeenCalled();
      expect(db.eventGameNomination.findMany).not.toHaveBeenCalled();
      expect(db.eventGame.findMany).not.toHaveBeenCalled();
    });
  });
});
