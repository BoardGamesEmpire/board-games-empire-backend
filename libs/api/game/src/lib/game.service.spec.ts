import type { Game } from '@bge/database';
import { Action, Prisma, ResourceType, Visibility } from '@bge/database';
import { AbilityService, PermissionsService } from '@bge/permissions';
import {
  batchTransactionCall,
  createMockAbilityService,
  createTestingModuleWithDb,
  MOCK_ACTING_USER_ID,
  paginationQuery,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { CreateGameDto, UpdateGameDto } from './dto';
import { GameService } from './game.service';

const COND = { id: 'sentinel-condition' };

const dependentRecordNotFound = () =>
  new Prisma.PrismaClientKnownRequestError('Record to fetch not found', { code: 'P2025', clientVersion: 'test' });

// The owner projection `updateGame` reads before it writes.
const userOwned = { createdBy: { isServiceAccount: false } } as never;
const serviceOwned = { createdBy: { isServiceAccount: true } } as never;

describe('GameService', () => {
  let service: GameService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;
  let permissions: jest.Mocked<Pick<PermissionsService, 'invalidateUser' | 'invalidateUsers'>>;

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
        { provide: AbilityService, useValue: abilityService },
        { provide: PermissionsService, useValue: permissions },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(GameService);
  });

  afterEach(() => jest.clearAllMocks());

  it('getGames → read', async () => {
    db.game.findMany.mockResolvedValue([]);
    db.game.count.mockResolvedValue(0);

    await service.getGames(paginationQuery({ limit: 20 }));

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Game, Action.read);
    expect(db.game.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ AND: [COND] }) }),
    );
  });

  // #372: `total` is only trustworthy against the rows because both come from
  // one snapshot, and nothing in the read itself enforces that — the mock
  // resolves the operation array at any isolation level, so a regression to the
  // Prisma default would be invisible without pinning it here.
  it('reads the rows and the count in one REPEATABLE READ transaction', async () => {
    db.game.findMany.mockResolvedValue([]);
    db.game.count.mockResolvedValue(0);

    await service.getGames(paginationQuery({ limit: 20 }));

    const { operations, options } = batchTransactionCall(db);
    expect(operations).toHaveLength(2);
    expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  });

  // A count over a wider `where` than the rows were read with reports a total
  // the caller can never page to — the ability conditions have to reach both.
  it('counts through the same scoped where as the rows', async () => {
    db.game.findMany.mockResolvedValue([]);
    db.game.count.mockResolvedValue(7);

    const page = await service.getGames(paginationQuery({ limit: 20 }));

    expect(db.game.count).toHaveBeenCalledWith({ where: expect.objectContaining({ AND: [COND] }) });
    expect(page).toEqual({ rows: [], total: 7 });
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

  it('createGame keeps the visibility it was sent, owned by the caller', async () => {
    db.game.create.mockResolvedValue({ id: 'game-1' } as Game);

    await service.createGame({ title: 'X', visibility: Visibility.Private });

    expect(db.game.create).toHaveBeenCalledWith({
      data: { title: 'X', visibility: Visibility.Private, createdBy: { connect: { id: MOCK_ACTING_USER_ID } } },
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
      select: { createdBy: { select: { isServiceAccount: true } } },
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

    await expect(service.updateGame('game-1', { visibility: Visibility.Private })).rejects.toThrow(ForbiddenException);
  });

  describe('a game the service account owns', () => {
    // Only an import produces one, and re-import never rewrites visibility, so
    // a server-owned game made private would stay private for good.
    it('refuses to be made private, before any write', async () => {
      db.game.findFirst.mockResolvedValue(serviceOwned);

      await expect(service.updateGame('game-1', { visibility: Visibility.Private })).rejects.toThrow(
        BadRequestException,
      );
      expect(db.game.update).not.toHaveBeenCalled();
    });

    it('answers 403, not 400, to a caller who may not change it at all', async () => {
      // The status follows the caller's rights, not the fields they sent.
      db.game.findFirst.mockResolvedValue(null);
      db.game.count.mockResolvedValue(1);

      await expect(service.updateGame('game-1', { visibility: Visibility.Private })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it.each<[string, UpdateGameDto]>([
      ['kept Public', { visibility: Visibility.Public }],
      ['edited without naming a visibility', { title: 'New' }],
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

    await service.updateGame('game-1', { visibility: Visibility.Private });

    expect(db.game.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ visibility: Visibility.Private }) }),
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
