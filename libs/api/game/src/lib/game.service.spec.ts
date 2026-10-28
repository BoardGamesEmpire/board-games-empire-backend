import type { Game } from '@bge/database';
import { Action, GAME_SUMMARY_SELECT, Prisma, Reach, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, PermissionsService, ScopeComposer } from '@bge/permissions';
import { RandomSampleQueryDto } from '@bge/shared';
import {
  batchTransactionCall,
  boundPageQuery,
  createMockAbilityService,
  createMockDatabaseService,
  createTestingModuleWithDb,
  MOCK_ACTING_USER_ID,
  type MockAbilityService,
  type MockDatabaseService,
  type PageQueryInit,
} from '@bge/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GAME_DESCRIPTION_MAX_LENGTH, ListGamesQueryDto, type CreateGameDto, type UpdateGameDto } from './dto';
import { gameListScope } from './game-list-scope';
import { GameService } from './game.service';

const COND = { id: 'sentinel-condition' };

const dependentRecordNotFound = () =>
  new Prisma.PrismaClientKnownRequestError('Record to fetch not found', { code: 'P2025', clientVersion: 'test' });

// The projection `updateGame` reads before it writes.
const userOwned = { createdBy: { isServiceAccount: false } } as never;
const serviceOwned = { createdBy: { isServiceAccount: true } } as never;
const userOwnedDescribed = (description: string) => ({ description, createdBy: { isServiceAccount: false } }) as never;

describe('GameService', () => {
  let service: GameService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;
  let permissions: jest.Mocked<Pick<PermissionsService, 'invalidateUser' | 'invalidateUsers'>>;
  let compose: jest.SpyInstance;

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([COND]);
    permissions = {
      invalidateUser: jest.fn().mockResolvedValue(undefined),
      invalidateUsers: jest.fn().mockResolvedValue(undefined),
    };

    const ctx = await createTestingModuleWithDb({
      providers: [
        GameService,
        // The REAL composer, over the mocked ability service, so the where
        // clauses asserted below are the merge the list actually runs.
        ScopeComposer,
        { provide: AbilityService, useValue: abilityService },
        { provide: PermissionsService, useValue: permissions },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(GameService);
    compose = jest.spyOn(ctx.module.get(ScopeComposer), 'compose');
  });

  afterEach(() => jest.clearAllMocks());

  /**
   * #513. `GET /games` used to take the caller's ceiling as its answer set, so
   * a plain user listed the Public games and their own, but staff listed
   * every private game on the server through `read:public_content`, and the
   * Owner through `manage:all`. It now declares that first set for everyone,
   * and the ceiling only clips it. The by-id read is unchanged, so a game
   * dropped from staff's list stays readable by id.
   *
   * `Game`'s envelope is guarded, so a regression that stops this read
   * composing answers 500 at the envelope rather than returning too much. That
   * is why the first test pins the composer call itself.
   */
  describe('getGames, as a converted game list', () => {
    // Built as the global pipe builds it, so the DTO's own defaults apply.
    const listQuery = (init: PageQueryInit<ListGamesQueryDto>) => boundPageQuery(ListGamesQueryDto, init);
    const read = () => service.getGames(listQuery({ limit: 20 }));

    beforeEach(() => {
      db.game.findMany.mockResolvedValue([]);
      db.game.count.mockResolvedValue(0);
    });

    it('asks the composer for its where clause, declaring the list scope of the acting user', async () => {
      await read();

      expect(compose).toHaveBeenCalledWith(ResourceType.Game, Action.read, gameListScope(MOCK_ACTING_USER_ID));
    });

    // Asking is not enough: the query has to use the answer. The ceiling stays
    // ANDed in, because for an `apiKey` actor it carries the key ∩ owner floor.
    it('queries with the composed clause, the ceiling clipping its scope rather than supplying it', async () => {
      await read();

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Game, Action.read);
      expect(db.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ...gameListScope(MOCK_ACTING_USER_ID), AND: [COND] },
        }),
      );
    });

    // #372: `total` is only trustworthy against the rows because both come
    // from one snapshot, and nothing in the read itself enforces that — the
    // mock resolves the operation array at any isolation level, so a
    // regression to the Prisma default would be invisible without pinning it
    // here. A count over a wider `where` reports a total the caller can never
    // page to.
    it('counts through the same where as the rows, in one REPEATABLE READ transaction', async () => {
      db.game.count.mockResolvedValue(7);

      const page = await read();

      const [findManyArgs] = db.game.findMany.mock.calls[0] as [{ where: unknown }];
      expect(db.game.count).toHaveBeenCalledWith({ where: findManyArgs.where });
      expect(page).toEqual({ rows: [], total: 7 });

      const { operations, options } = batchTransactionCall(db);
      expect(operations).toHaveLength(2);
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    });

    // #959: a client that names no sort keeps today's order. The query DTO
    // supplies the title default; the service has no fallback of its own.
    it('orders by title, then id, when no sort is named', async () => {
      await read();

      expect(db.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ title: 'asc' }, { id: 'asc' }] }),
      );
    });

    // #959: newest first, the id deciding between games added in the same millisecond.
    it('orders newest first, then id descending, for the newest sort', async () => {
      await service.getGames(listQuery({ limit: 20, sort: 'newest' }));

      expect(db.game.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      );
    });

    // #959: a sort reorders the list and never widens it.
    it('reads the same set under either sort', async () => {
      await service.getGames(listQuery({ limit: 20, sort: 'title' }));
      await service.getGames(listQuery({ limit: 20, sort: 'newest' }));

      const [[byTitle], [byNewest]] = db.game.findMany.mock.calls as [[{ where: unknown }], [{ where: unknown }]];
      expect(byNewest.where).toEqual(byTitle.where);
      expect(db.game.count).toHaveBeenNthCalledWith(2, { where: byTitle.where });
    });

    // PROVISIONAL (#395). Half of the scope is the caller's own games, which
    // has no meaning for an actor with no user behind it. The refusal must
    // stay one rather than soften into a page of Public games, which would
    // settle #395's question by accident. The key is the read's own, not the
    // write-flavoured one `getActingUserId` throws.
    it('refuses an actor kind with no user behind it rather than answering a page of Public games', async () => {
      abilityService.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException(t('errors.actor_context.not_user_attributable', { kind: 'plugin' }));
      });

      const rejection: unknown = await read().catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(ForbiddenException);
      expect((rejection as ForbiddenException).getResponse()).toEqual(t('common.forbidden.access'));
      expect(db.game.findMany).not.toHaveBeenCalled();
    });
  });

  /**
   * #961. What a new member's home page shows: a uniform sample of the set
   * `GET /games` lists, read one game per random offset so nothing loads the
   * whole game catalog.
   */
  describe('getRandomGames (#961)', () => {
    // The transaction's own client, apart from `db`, so a read that escaped
    // the snapshot would land on `db` and show.
    let tx: MockDatabaseService;

    const sampleOf = (size: number) => service.getRandomGames(Object.assign(new RandomSampleQueryDto(), { size }));
    const gameIds = (count: number) =>
      Array.from({ length: count }, (_, index) => `g-${String(index).padStart(2, '0')}`);

    // Reads as Prisma's cursor does: `skip` games on from the cursor's game,
    // or from the first game without one.
    const walkOver = (ids: string[]) =>
      (async (args: { skip: number; cursor?: { id: string } }) => {
        const id = ids[(args.cursor ? ids.indexOf(args.cursor.id) : 0) + args.skip];

        return id === undefined ? null : { id };
      }) as never;

    beforeEach(() => {
      tx = createMockDatabaseService();
      db.$transaction.mockImplementation(((fn: (client: MockDatabaseService) => Promise<unknown>) => fn(tx)) as never);
      tx.game.count.mockResolvedValue(30);
      tx.game.findFirst.mockImplementation(walkOver(gameIds(30)));
    });

    it("asks the composer for the game list's intrinsic scope for the acting user", async () => {
      await sampleOf(10);

      expect(compose).toHaveBeenCalledWith(ResourceType.Game, Action.read, gameListScope(MOCK_ACTING_USER_ID));
    });

    // The offsets index the counted set, so the count and every read must see
    // one set: the same where, in one snapshot.
    it('counts and reads through the same where, in one REPEATABLE READ transaction', async () => {
      await sampleOf(10);

      expect(db.$transaction.mock.calls[0][1 as never]).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });

      const [[countArgs]] = tx.game.count.mock.calls as [[{ where: unknown }]];
      expect(countArgs.where).toEqual({ ...gameListScope(MOCK_ACTING_USER_ID), AND: [COND] });
      for (const [args] of tx.game.findFirst.mock.calls as [{ where: unknown }][]) {
        expect(args.where).toBe(countArgs.where);
      }

      expect(db.game.count).not.toHaveBeenCalled();
      expect(db.game.findFirst).not.toHaveBeenCalled();
    });

    it('reads min(size, count) distinct offsets, each ordered by id with the summary select', async () => {
      const games = await sampleOf(10);

      expect(tx.game.findFirst).toHaveBeenCalledTimes(10);
      for (const [args] of tx.game.findFirst.mock.calls) {
        expect(args).toEqual(expect.objectContaining({ orderBy: { id: 'asc' }, select: GAME_SUMMARY_SELECT }));
      }

      expect(games).toHaveLength(10);
      expect(new Set(games.map((game) => game.id)).size).toBe(10);
      expect(games.every((game) => gameIds(30).includes(game.id))).toBe(true);
    });

    // A read at offset k walks k games, so each read starts from the game the
    // last one found and the sample walks the set once.
    it('walks the offsets in id order, each read starting from the game the last one found', async () => {
      await sampleOf(10);

      const calls = tx.game.findFirst.mock.calls as [{ skip: number; cursor?: { id: string } }][];
      const found = (await Promise.all(tx.game.findFirst.mock.results.map((result) => result.value))) as {
        id: string;
      }[];
      expect(calls[0][0].cursor).toBeUndefined();
      for (const [index, [args]] of calls.slice(1).entries()) {
        expect(args.cursor).toEqual({ id: found[index].id });
        expect(args.skip).toBeGreaterThan(0);
      }
    });

    // Fewer games than size: each comes back once, none twice.
    it('reads every game once when the set is smaller than size', async () => {
      tx.game.count.mockResolvedValue(3);
      tx.game.findFirst.mockImplementation(walkOver(gameIds(3)));

      const games = await sampleOf(10);

      expect(games.map((game) => game.id).sort()).toEqual(gameIds(3));
    });

    it('reads no game when the set is empty', async () => {
      tx.game.count.mockResolvedValue(0);

      expect(await sampleOf(10)).toEqual([]);
      expect(tx.game.findFirst).not.toHaveBeenCalled();
    });

    // PROVISIONAL (#395), as for the list: half the set is the caller's own
    // games, which has no meaning without a user behind the actor.
    it('refuses an actor kind with no user behind it rather than sampling the Public games', async () => {
      abilityService.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException(t('errors.actor_context.not_user_attributable', { kind: 'plugin' }));
      });

      const rejection: unknown = await sampleOf(10).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(ForbiddenException);
      expect((rejection as ForbiddenException).getResponse()).toEqual(t('common.forbidden.access'));
      expect(db.$transaction).not.toHaveBeenCalled();
    });
  });

  it('getGame → read (single round trip on the happy path)', async () => {
    db.game.findUniqueOrThrow.mockResolvedValue({ id: 'game-1' } as Game);

    await service.getGame('game-1');

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Game, Action.read);
    expect(db.game.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'game-1', AND: [COND] }) }),
    );
    // No pre-flight count: the read is one query when the row is visible.
    expect(db.game.count).not.toHaveBeenCalled();
  });

  it('getGame throws NotFound when the row is absent', async () => {
    db.game.findUniqueOrThrow.mockRejectedValue(dependentRecordNotFound());
    db.game.count.mockResolvedValue(0);

    await expect(service.getGame('game-1')).rejects.toThrow(NotFoundException);
  });

  it('getGame throws Forbidden when the row exists but is not readable', async () => {
    db.game.findUniqueOrThrow.mockRejectedValue(dependentRecordNotFound());
    db.game.count.mockResolvedValue(1);

    await expect(service.getGame('game-1')).rejects.toThrow(ForbiddenException);
  });

  it('createGame does not filter by abilities and evicts the creator’s permission graph', async () => {
    db.game.create.mockResolvedValue({ id: 'game-1' } as Game);

    await service.createGame({ title: 'X' } as CreateGameDto);

    expect(abilityService.getCurrentResourceConditions).not.toHaveBeenCalled();
    expect(permissions.invalidateUser).toHaveBeenCalledWith(MOCK_ACTING_USER_ID);
  });

  it('createGame keeps the reach it was sent, owned by the caller', async () => {
    db.game.create.mockResolvedValue({ id: 'game-1' } as Game);

    await service.createGame({ title: 'X', reach: Reach.Private });

    expect(db.game.create).toHaveBeenCalledWith({
      data: { title: 'X', reach: Reach.Private, createdBy: { connect: { id: MOCK_ACTING_USER_ID } } },
    });
  });

  describe('a typed-in description', () => {
    const unsafe = 'Trade <b>wisely</b>. [Rules](javascript:alert(1))';

    it('createGame stores it as Markdown with raw HTML and unsafe links taken out', async () => {
      db.game.create.mockResolvedValue({ id: 'game-1' } as Game);

      await service.createGame({ title: 'X', description: unsafe });

      expect(db.game.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ description: 'Trade wisely. Rules' }),
      });
    });

    it('updateGame does the same', async () => {
      db.game.findFirst.mockResolvedValue(userOwned);
      db.game.update.mockResolvedValue({ id: 'game-1' } as Game);

      await service.updateGame('game-1', { description: unsafe });

      expect(db.game.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ description: 'Trade wisely. Rules' }) }),
      );
    });

    it('updateGame still clears it with null, and leaves it alone when left out', async () => {
      db.game.findFirst.mockResolvedValue(userOwned);
      db.game.update.mockResolvedValue({ id: 'game-1' } as Game);

      await service.updateGame('game-1', { description: null as unknown as string });
      await service.updateGame('game-1', { title: 'New' });

      expect(db.game.update.mock.calls[0][0].data.description).toBeNull();
      expect(db.game.update.mock.calls[1][0].data.description).toBeUndefined();
    });

    describe('longer than the cap', () => {
      const tooLong = new BadRequestException(
        t('errors.game.description_too_long', { max: GAME_DESCRIPTION_MAX_LENGTH }),
      );

      it('createGame refuses it, and accepts one at the cap', async () => {
        db.game.create.mockResolvedValue({ id: 'game-1' } as Game);

        await expect(
          service.createGame({ title: 'X', description: 'a'.repeat(GAME_DESCRIPTION_MAX_LENGTH + 1) }),
        ).rejects.toThrow(tooLong);
        expect(db.game.create).not.toHaveBeenCalled();

        await service.createGame({ title: 'X', description: 'a'.repeat(GAME_DESCRIPTION_MAX_LENGTH) });
        expect(db.game.create).toHaveBeenCalledTimes(1);
      });

      it('updateGame refuses it when it changes the description', async () => {
        db.game.findFirst.mockResolvedValue(userOwnedDescribed('Short'));

        await expect(
          service.updateGame('game-1', { description: 'a'.repeat(GAME_DESCRIPTION_MAX_LENGTH + 1) }),
        ).rejects.toThrow(tooLong);
        expect(db.game.update).not.toHaveBeenCalled();
      });
    });

    it('updateGame keeps the description the game already has, however long, rather than sanitizing it again', async () => {
      // An import stores what it converted, which can be longer than the cap,
      // and a client may send it back unchanged with an edit to another field.
      const stored = String.raw`\*Escaped\* ` + 'a'.repeat(GAME_DESCRIPTION_MAX_LENGTH);
      db.game.findFirst.mockResolvedValue(userOwnedDescribed(stored));
      db.game.update.mockResolvedValue({ id: 'game-1' } as Game);

      await service.updateGame('game-1', { title: 'New', description: stored });

      expect(db.game.update.mock.calls[0][0].data).toEqual(expect.objectContaining({ title: 'New' }));
      expect(db.game.update.mock.calls[0][0].data.description).toBeUndefined();
    });
  });

  it('updateGame → update, and evicts the updater’s permission graph', async () => {
    db.game.findFirst.mockResolvedValue(userOwned);
    db.game.update.mockResolvedValue({ id: 'game-1' } as Game);

    await service.updateGame('game-1', { title: 'New' } as CreateGameDto);

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Game, Action.update);
    expect(db.game.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'game-1', AND: [COND] }) }),
    );
    expect(permissions.invalidateUser).toHaveBeenCalledWith(MOCK_ACTING_USER_ID);
  });

  it('updateGame rejects an empty patch', async () => {
    await expect(service.updateGame('game-1', {} as CreateGameDto)).rejects.toThrow(BadRequestException);
  });

  it('updateGame reads the row through the update conditions before it writes', async () => {
    db.game.findFirst.mockResolvedValue(userOwned);
    db.game.update.mockResolvedValue({ id: 'game-1' } as Game);

    await service.updateGame('game-1', { title: 'New' });

    expect(db.game.findFirst).toHaveBeenCalledWith({
      where: { id: 'game-1', AND: [COND] },
      select: {
        description: true,
        minPlayers: true,
        maxPlayers: true,
        minPlayTime: true,
        maxPlayTime: true,
        createdBy: { select: { isServiceAccount: true } },
      },
    });
  });

  /**
   * #869. The DTO refuses a range sent whole in the wrong order, but a PATCH
   * may send one end alone, so the service holds it to the end already stored.
   */
  describe('a range given one end at a time', () => {
    const stored = {
      minPlayers: 2,
      maxPlayers: 4,
      minPlayTime: 60,
      maxPlayTime: 120,
      createdBy: { isServiceAccount: false },
    } as never;

    beforeEach(() => {
      db.game.findFirst.mockResolvedValue(stored);
      db.game.update.mockResolvedValue({ id: 'game-1' } as Game);
    });

    it.each<[string, UpdateGameDto, Record<string, unknown>]>([
      [
        'a maximum play time below the stored minimum',
        { maxPlayTime: 30 },
        { minField: 'minPlayTime', min: 60, maxField: 'maxPlayTime', max: 30 },
      ],
      [
        'a minimum play time above the stored maximum',
        { minPlayTime: 180 },
        { minField: 'minPlayTime', min: 180, maxField: 'maxPlayTime', max: 120 },
      ],
      [
        'a maximum player count below the stored minimum',
        { maxPlayers: 1 },
        { minField: 'minPlayers', min: 2, maxField: 'maxPlayers', max: 1 },
      ],
      [
        'a minimum player count above the stored maximum',
        { minPlayers: 5 },
        { minField: 'minPlayers', min: 5, maxField: 'maxPlayers', max: 4 },
      ],
    ])('refuses %s, before any write', async (_label, patch, args) => {
      const refusal = service.updateGame('game-1', patch);

      await expect(refusal).rejects.toThrow(BadRequestException);
      await expect(refusal).rejects.toMatchObject({ response: { key: 'errors.game.range_reversed', args } });
      expect(db.game.update).not.toHaveBeenCalled();
    });

    it.each<[string, UpdateGameDto]>([
      ['an end equal to the stored other end', { maxPlayTime: 60, minPlayers: 4 }],
      ['both ends moved past the stored ones, in order', { minPlayTime: 150, maxPlayTime: 180 }],
      ['the other end cleared with null', { minPlayTime: null as unknown as number, maxPlayTime: 30 }],
      ['no range at all', { title: 'New' }],
    ])('takes %s', async (_label, patch) => {
      await service.updateGame('game-1', patch);

      expect(db.game.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining(patch) }));
    });

    it('takes either end when the other is unknown', async () => {
      db.game.findFirst.mockResolvedValue(userOwned);

      await service.updateGame('game-1', { maxPlayTime: 1 });
      await service.updateGame('game-1', { minPlayers: 99 });

      expect(db.game.update).toHaveBeenCalledTimes(2);
    });
  });

  it('updateGame throws NotFound when the row is absent', async () => {
    db.game.findFirst.mockResolvedValue(null);
    db.game.count.mockResolvedValue(0);

    await expect(service.updateGame('game-1', { title: 'New' })).rejects.toThrow(NotFoundException);
    expect(db.game.update).not.toHaveBeenCalled();
  });

  it('updateGame throws Forbidden when the row exists but the caller may not change it', async () => {
    db.game.findFirst.mockResolvedValue(null);
    db.game.count.mockResolvedValue(1);

    await expect(service.updateGame('game-1', { title: 'New' })).rejects.toThrow(ForbiddenException);
    expect(db.game.update).not.toHaveBeenCalled();
  });

  it('updateGame throws Forbidden when the row leaves the conditions before the write', async () => {
    db.game.findFirst.mockResolvedValue(userOwned);
    db.game.update.mockRejectedValue(dependentRecordNotFound());

    await expect(service.updateGame('game-1', { reach: Reach.Private })).rejects.toThrow(ForbiddenException);
  });

  describe('a game the service account owns', () => {
    // Only an import produces one, and re-import never rewrites reach, so
    // a server-owned game made private would stay private for good.
    it('refuses to be made private, before any write', async () => {
      db.game.findFirst.mockResolvedValue(serviceOwned);

      await expect(service.updateGame('game-1', { reach: Reach.Private })).rejects.toThrow(BadRequestException);
      expect(db.game.update).not.toHaveBeenCalled();
    });

    it('answers 403, not 400, to a caller who may not change it at all', async () => {
      // The status follows the caller's rights, not the fields they sent.
      db.game.findFirst.mockResolvedValue(null);
      db.game.count.mockResolvedValue(1);

      await expect(service.updateGame('game-1', { reach: Reach.Private })).rejects.toThrow(ForbiddenException);
    });

    it.each<[string, UpdateGameDto]>([
      ['kept Public', { reach: Reach.Public }],
      ['edited without naming a reach', { title: 'New' }],
    ])('can still be %s', async (_label, patch) => {
      db.game.findFirst.mockResolvedValue(serviceOwned);
      db.game.update.mockResolvedValue({ id: 'game-1' } as Game);

      await service.updateGame('game-1', patch);

      expect(db.game.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining(patch) }));
    });
  });

  it.each([
    ['its creator’s game', userOwned],
    ['a game whose creator was deleted', { createdBy: null } as never],
  ])('updateGame lets %s be made private', async (_label, existing) => {
    db.game.findFirst.mockResolvedValue(existing);
    db.game.update.mockResolvedValue({ id: 'game-1' } as Game);

    await service.updateGame('game-1', { reach: Reach.Private });

    expect(db.game.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reach: Reach.Private }) }),
    );
  });

  it('deleteGame → delete (and blocks when in a collection)', async () => {
    db.game.count.mockResolvedValue(1);
    db.gameCollection.count.mockResolvedValue(0);
    db.game.delete.mockResolvedValue({ id: 'game-1' } as Game);

    await service.deleteGame('game-1');

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Game, Action.delete);
    expect(db.game.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'game-1', AND: [COND] }) }),
    );
  });

  it('deleteGame is blocked when the game is part of a collection', async () => {
    db.game.count.mockResolvedValue(1);
    db.gameCollection.count.mockResolvedValue(2);

    await expect(service.deleteGame('game-1')).rejects.toThrow(BadRequestException);
    expect(db.game.delete).not.toHaveBeenCalled();
  });
});
