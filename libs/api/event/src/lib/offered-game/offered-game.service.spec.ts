import { Action, EventParticipationStatus, ListKind, Prisma, ResourceType } from '@bge/database';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import {
  batchTransactionCall,
  createMockAbilityService,
  createTestingModuleWithDb,
  MOCK_ACTING_USER_ID,
  paginationQuery,
  unwrapTransaction,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { ACTIVE_NOMINATION_STATUSES, lineupStillAhead } from '../attendee/attendance';
import { ListOfferedGamesQueryDto } from './dto/list-offered-games.query.dto';
import { makeOfferedGameEntry } from './offered-game.fixture';
import { OFFERED_GAME_ATTENDEE_SELECT, OFFERED_GAME_ORDER, OFFERED_GAME_SELECT } from './offered-game.select';
import { OfferedGameService } from './offered-game.service';
import { offeredGamesFilter } from './offered-games.filter';

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
    // The actor's wishlist is readable, unless a spec says otherwise (#1241).
    db.list.findFirst.mockResolvedValue({ id: 'wishlist-1' } as never);
    db.listEntry.findMany.mockResolvedValue([]);
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

    // A client shows "a game you want" on an offered game from this flag. It is
    // null, not false, where the actor has no wishlist to read (#1241).
    it("says which offered games are on the acting user's wishlist, null for an actor who cannot read one (#1241)", async () => {
      const entries = [
        makeOfferedGameEntry('a', 'game-1'),
        makeOfferedGameEntry('b', 'game-2'),
        makeOfferedGameEntry('c', 'game-3'),
      ];
      // game-1 is wishlisted as a game, game-2's platform game directly, game-3 not at all.
      db.listEntry.findMany.mockResolvedValue([
        { gameId: 'game-1', platformGameId: null },
        { gameId: null, platformGameId: 'pg-game-2' },
      ] as never);

      const enriched = await service.enrich(entries, NOW);

      expect(enriched.map((row) => row.onWishlist)).toEqual([true, true, false]);
      expect(compose).toHaveBeenCalledWith(ResourceType.List, Action.read, {
        userId: MOCK_ACTING_USER_ID,
        kind: ListKind.Wishlist,
      });
      // The ceiling-composed wishlist read is top-level; the entry read names
      // the wishlist it found by id.
      expect(db.list.findFirst.mock.calls[0][0]?.where).toMatchObject({
        userId: MOCK_ACTING_USER_ID,
        kind: ListKind.Wishlist,
        AND: [COND],
      });
      expect(db.listEntry.findMany).toHaveBeenCalledTimes(1);
      expect(db.listEntry.findMany.mock.calls[0][0]?.where).toMatchObject({ listId: 'wishlist-1' });

      // List read access that doesn't reach the wishlist: a key whose list
      // grant is pinned to one custom list, or a user with no wishlist row.
      db.list.findFirst.mockResolvedValueOnce(null);
      db.listEntry.findMany.mockClear();
      const unreachable = await service.enrich(entries, NOW);
      expect(unreachable.map((row) => row.onWishlist)).toEqual([null, null, null]);
      expect(db.listEntry.findMany).not.toHaveBeenCalled();

      // No list read: an anonymous user, or a key without a list grant.
      db.list.findFirst.mockClear();
      abilityService.getCurrentAccess.mockImplementation(((types: readonly string[]) =>
        Object.fromEntries(
          types.map((type) => [type, { [Action.read]: type === ResourceType.List ? 'none' : 'some' }]),
        )) as never);
      const noListRead = await service.enrich(entries, NOW);
      expect(noListRead.map((row) => row.onWishlist)).toEqual([null, null, null]);

      // No acting user: a plugin, system or external actor.
      abilityService.getCurrentAccess.mockReturnValue({});
      abilityService.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException('not user attributable');
      });
      const noUser = await service.enrich(entries, NOW);
      expect(noUser.map((row) => row.onWishlist)).toEqual([null, null, null]);

      expect(db.list.findFirst).not.toHaveBeenCalled();
      expect(db.listEntry.findMany).not.toHaveBeenCalled();
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
  describe('listOfferedGames (#1187)', () => {
    const query = (init: Record<string, unknown> = {}) =>
      plainToInstance(ListOfferedGamesQueryDto, { limit: 10, ...init }, { enableImplicitConversion: true });

    /** The attendee read's row, as `OFFERED_GAME_ATTENDEE_SELECT` reads it. */
    const attendee = (id: string, overrides: Record<string, unknown> = {}) => ({
      id,
      status: EventParticipationStatus.Attending,
      guestName: null,
      user: { id: `user-${id}`, username: `name-${id}`, profile: { displayName: null, avatarUrl: null } },
      ...overrides,
    });

    let page: jest.SpyInstance;

    beforeEach(() => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findMany.mockResolvedValue([]);
      db.eventAttendeeGameList.count.mockResolvedValue(0);
      page = jest.spyOn(service, 'page');
    });

    // Removed entries, and every entry of a removed attendee, leave both the
    // rows and the total; the query's filters are ANDed beside them.
    it("scopes the read to the event's live attendees and live entries, with the filters ANDed", async () => {
      const listed = query({ excludeAttendeeIds: 'att-9', q: 'catan', playerCountMin: '4' });

      await service.listOfferedGames('event-1', listed);

      const scope = {
        removedAt: null,
        attendee: { is: { eventId: 'event-1', removedAt: null } },
        AND: offeredGamesFilter(listed),
      };
      expect(page).toHaveBeenCalledWith(scope, listed, expect.any(Date));
      expect(scope.AND).toHaveLength(3);
      expect(db.eventAttendeeGameList.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ...scope, AND: [...offeredGamesFilter(listed), COND] },
          skip: 0,
          take: 10,
        }),
      );
    });

    // In the entry's select, the attendee's name and avatar would reach a key
    // holding only read on offered games (#404, #559).
    it("reads the page's attendees once, under the attendee read ceiling (#1187)", async () => {
      db.eventAttendeeGameList.findMany.mockResolvedValue([
        makeOfferedGameEntry('a', 'game-1', 'att-1'),
        makeOfferedGameEntry('b', 'game-2', 'att-2'),
        makeOfferedGameEntry('c', 'game-3', 'att-1'),
      ] as never);
      db.eventAttendeeGameList.count.mockResolvedValue(3);
      db.eventAttendee.findMany.mockResolvedValue([attendee('att-1')] as never);

      const listed = await service.listOfferedGames('event-1', query());

      expect(compose).toHaveBeenCalledWith(ResourceType.EventAttendee, Action.read, { id: { in: ['att-1', 'att-2'] } });
      expect(db.eventAttendee.findMany).toHaveBeenCalledTimes(1);
      expect(db.eventAttendee.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['att-1', 'att-2'] }, AND: [COND] },
        select: OFFERED_GAME_ATTENDEE_SELECT,
      });
      expect(listed.total).toBe(3);
      expect(listed.rows.map((row) => [row.id, row.attendeeId, row.attendee?.id ?? null])).toEqual([
        ['a', 'att-1', 'att-1'],
        ['b', 'att-2', null],
        ['c', 'att-1', 'att-1'],
      ]);
    });

    // Not attending is an answer an attendee can change; their games stay on
    // their list, and the row says why they can't be nominated.
    it('keeps an attendee answering Not attending, with their status', async () => {
      db.eventAttendeeGameList.findMany.mockResolvedValue([makeOfferedGameEntry('a', 'game-1', 'att-1')] as never);
      db.eventAttendee.findMany.mockResolvedValue([
        attendee('att-1', { status: EventParticipationStatus.NotAttending }),
      ] as never);

      const listed = await service.listOfferedGames('event-1', query());

      expect(JSON.stringify(page.mock.calls[0][0])).not.toContain('status');
      expect(listed.rows[0].attendee?.status).toBe(EventParticipationStatus.NotAttending);
    });

    // A host can offer games for a guest added by name (#1210), whose row has
    // no user.
    it('serves a guest attendee with a null user', async () => {
      db.eventAttendeeGameList.findMany.mockResolvedValue([makeOfferedGameEntry('a', 'game-1', 'att-guest')] as never);
      db.eventAttendee.findMany.mockResolvedValue([attendee('att-guest', { user: null, guestName: 'Sam' })] as never);

      const listed = await service.listOfferedGames('event-1', query());

      expect(listed.rows[0].attendee).toEqual({
        id: 'att-guest',
        status: EventParticipationStatus.Attending,
        guestName: 'Sam',
        user: null,
      });
    });

    it("answers 404 for an event that doesn't exist, before reading", async () => {
      db.event.count.mockResolvedValue(0);

      await expect(service.listOfferedGames('missing', query())).rejects.toThrow(NotFoundException);
      expect(db.eventAttendeeGameList.findMany).not.toHaveBeenCalled();
      expect(db.eventAttendee.findMany).not.toHaveBeenCalled();
    });

    it('reads no attendee for an empty page', async () => {
      await expect(service.listOfferedGames('event-1', query())).resolves.toEqual({ rows: [], total: 0 });

      expect(db.eventAttendee.findMany).not.toHaveBeenCalled();
    });
  });
});
