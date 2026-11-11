import { Action, Prisma, ResourceType } from '@bge/database';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import {
  batchTransactionCall,
  createMockAbilityService,
  createTestingModuleWithDb,
  paginationQuery,
  unwrapTransaction,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { ACTIVE_NOMINATION_STATUSES, lineupStillAhead } from '../attendee/attendance';
import { makeOfferedGameEntry } from './offered-game.fixture';
import { OFFERED_GAME_ORDER, OFFERED_GAME_SELECT } from './offered-game.select';
import { OfferedGameService } from './offered-game.service';

const COND = { id: 'sentinel-condition' };
const NOW = new Date('2026-11-11T12:00:00Z');

describe('OfferedGameService (#1185, #1187)', () => {
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

    unwrapTransaction(db);
    db.gameExpansion.findMany.mockResolvedValue([]);
    db.eventGameNomination.findMany.mockResolvedValue([]);
    db.eventGame.findMany.mockResolvedValue([]);
    db.eventAttendeeGameList.findMany.mockResolvedValue([]);
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
        [
          makeOfferedGameEntry('a', 'game-exp'),
          makeOfferedGameEntry('b', 'game-base'),
          makeOfferedGameEntry('c', 'game-exp'),
        ],
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

      const enriched = await service.enrich(
        [makeOfferedGameEntry('a', 'game-1'), makeOfferedGameEntry('b', 'game-2')],
        NOW,
      );

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

      const [row] = await service.enrich([makeOfferedGameEntry('a', 'game-1')], NOW);

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
  describe('page (#1001, #1187)', () => {
    // A count through any other where, or outside the rows' snapshot, lets
    // `totalPages` promise a page that comes back short (#373, #1187).
    it('reads one page and its total under the offered-games read ceiling, in one REPEATABLE READ transaction', async () => {
      db.eventAttendeeGameList.findMany.mockResolvedValue([makeOfferedGameEntry('a')] as never);
      db.eventAttendeeGameList.count.mockResolvedValue(4);

      const page = await service.page({ attendeeId: 'att-1' }, paginationQuery({ page: 3, limit: 1 }), NOW);

      const where = { attendeeId: 'att-1', AND: [COND] };
      expect(compose).toHaveBeenCalledWith(ResourceType.EventAttendeeGameList, Action.read, { attendeeId: 'att-1' });
      expect(db.eventAttendeeGameList.findMany).toHaveBeenCalledWith({
        where,
        select: OFFERED_GAME_SELECT,
        orderBy: OFFERED_GAME_ORDER,
        skip: 2,
        take: 1,
      });
      expect(db.eventAttendeeGameList.count).toHaveBeenCalledWith({ where });
      const { operations, options } = batchTransactionCall(db);
      expect(operations).toHaveLength(2);
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      expect(page.total).toBe(4);
      expect(page.rows).toEqual([expect.objectContaining({ id: 'a', supplies: { nominations: 0, lineup: 0 } })]);
    });
  });

  describe('forAttendees (#404)', () => {
    it("groups each attendee's live offered games in title order, an attendee with none mapped to []", async () => {
      db.eventAttendeeGameList.findMany.mockResolvedValue([
        makeOfferedGameEntry('a', 'game-1', 'att-2'),
        makeOfferedGameEntry('b', 'game-2', 'att-1'),
        makeOfferedGameEntry('c', 'game-3', 'att-2'),
      ] as never);

      const games = await service.forAttendees(['att-1', 'att-2', 'att-3'], NOW);

      expect(compose).toHaveBeenCalledWith(ResourceType.EventAttendeeGameList, Action.read, {
        attendeeId: { in: ['att-1', 'att-2', 'att-3'] },
        removedAt: null,
      });
      expect(db.eventAttendeeGameList.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ select: OFFERED_GAME_SELECT, orderBy: OFFERED_GAME_ORDER }),
      );
      expect([...games].map(([id, rows]) => [id, rows.map((row) => row.id)])).toEqual([
        ['att-1', ['b']],
        ['att-2', ['a', 'c']],
        ['att-3', []],
      ]);
    });

    it('reads nothing for no attendees', async () => {
      await expect(service.forAttendees([], NOW)).resolves.toEqual(new Map());

      expect(db.eventAttendeeGameList.findMany).not.toHaveBeenCalled();
    });
  });
});
