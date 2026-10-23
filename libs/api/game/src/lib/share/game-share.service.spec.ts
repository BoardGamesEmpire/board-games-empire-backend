import {
  Action,
  blockWith,
  HUMAN_USER_WHERE,
  MemberSharePolicy,
  Prisma,
  ResourceType,
  SystemRole,
  type GameShare,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import {
  batchTransactionCall,
  createTestingModuleWithDb,
  paginationQuery,
  unwrapTransaction,
  type MockDatabaseService,
} from '@bge/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { CreateGameShareDto } from './dto';
import { GameShareCreatedEvent, GameShareDeletedEvent, GameShareEvents } from './game-share.events';
import { GameShareService } from './game-share.service';

const COND = { id: 'sentinel-condition' };
const NOW = new Date('2026-10-22T12:00:00Z');

type RosterRow = { userId: string; role: { role: { name: string } } | null };

const rosterRow = (userId: string, name: SystemRole): RosterRow => ({ userId, role: { role: { name } } });

const ROSTER: RosterRow[] = [
  rosterRow('owner-1', SystemRole.HouseholdOwner),
  rosterRow('member-1', SystemRole.HouseholdMember),
];

const SETTINGS = { memberSharePolicy: MemberSharePolicy.NeedsApproval };

/** The game as the create reads it: the acting user's own, live. */
const GAME = { id: 'game-1', deletedAt: null, createdById: 'owner-1' };

/** What a household create asks about: a share of `game-1` into `hh-1`, in effect or waiting. */
const householdInstance = (approvedAt: Date | null, members: RosterRow[] = ROSTER) => ({
  householdId: 'hh-1',
  approvedAt,
  game: { deletedAt: null, createdById: 'owner-1' },
  household: { settings: SETTINGS, members },
});

const shareRow = (overrides: Partial<GameShare> = {}): GameShare => ({
  id: 'share-1',
  gameId: 'game-1',
  userId: 'user-2',
  householdId: null,
  sharedById: 'owner-1',
  approvedById: null,
  approvedAt: NOW,
  createdAt: NOW,
  ...overrides,
});

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });

const foreignKeyViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', { code: 'P2003', clientVersion: 'test' });

const dependentRecordNotFound = () =>
  new Prisma.PrismaClientKnownRequestError('Record to delete does not exist', { code: 'P2025', clientVersion: 'test' });

/** Prisma's delegate types want full rows; the service selects narrower ones. */
const resolves = (value: unknown) => value as never;

describe('GameShareService', () => {
  let service: GameShareService;
  let db: MockDatabaseService;
  let abilityService: jest.Mocked<
    Pick<
      AbilityService,
      'getActingUserId' | 'assertCurrentActorCan' | 'currentActorCan' | 'getCurrentResourceConditions'
    >
  >;
  let emitter: { emit: jest.Mock };
  let compose: jest.SpyInstance;

  beforeEach(async () => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });

    abilityService = {
      getActingUserId: jest.fn().mockReturnValue('owner-1'),
      assertCurrentActorCan: jest.fn(),
      currentActorCan: jest.fn().mockReturnValue(true),
      getCurrentResourceConditions: jest.fn().mockReturnValue([COND]),
    };
    emitter = { emit: jest.fn() };

    const ctx = await createTestingModuleWithDb({
      providers: [
        GameShareService,
        // The real composer over the mocked ability service, as in
        // `game.service.spec.ts`, so the list's where clause is the merge it runs.
        ScopeComposer,
        { provide: AbilityService, useValue: abilityService },
        { provide: EventEmitter2, useValue: emitter },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(GameShareService);
    compose = jest.spyOn(ctx.module.get(ScopeComposer), 'compose');

    unwrapTransaction(db);
    db.game.findFirst.mockResolvedValue(resolves(GAME));
    db.user.findUnique.mockResolvedValue(resolves({ id: 'user-2' }));
    db.user.count.mockResolvedValue(0);
    db.household.findUnique.mockResolvedValue(resolves({ settings: SETTINGS, members: ROSTER }));
    db.$queryRaw.mockResolvedValue([{ id: 'hh-1' }] as never);
    db.gameShare.create.mockImplementation(((args: { data: Partial<GameShare> }) =>
      Promise.resolve(shareRow({ ...args.data }))) as never);
    db.gameShare.findFirst.mockResolvedValue(shareRow());
    db.gameShare.delete.mockResolvedValue(shareRow());
    db.householdMember.findMany.mockResolvedValue(resolves(ROSTER));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  /** Logs the transaction's commit, so a spec can place the emit after it. */
  const loggingCommit = (steps: string[]) =>
    db.$transaction.mockImplementation((async (operations: unknown) => {
      if (Array.isArray(operations)) {
        return Promise.all(operations);
      }

      const result = await (operations as (tx: MockDatabaseService) => Promise<unknown>)(db);
      steps.push('commit');

      return result;
    }) as never);

  describe('create', () => {
    const toUser: CreateGameShareDto = { userId: 'user-2' };
    const toHousehold: CreateGameShareDto = { householdId: 'hh-1' };

    const createdWith = () => db.gameShare.create.mock.calls[0]?.[0];

    it.each([
      ['neither recipient', {}],
      ['both recipients', { userId: 'user-2', householdId: 'hh-1' }],
      // `@IsOptional` lets a JSON null through, and it names nobody.
      ['a null user alone', { userId: null }],
      ['a null household alone', { householdId: null }],
    ])('refuses %s with 400 before touching the database', async (_label, dto) => {
      await expect(service.create('game-1', dto as CreateGameShareDto)).rejects.toBeInstanceOf(BadRequestException);

      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it("answers 403 for a live game the acting user didn't create, whatever wildcard they hold, before asking anything", async () => {
      db.game.findFirst.mockResolvedValue(null);
      db.game.count.mockResolvedValue(1);

      await expect(service.create('game-1', toUser)).rejects.toEqual(
        new ForbiddenException(t('errors.game_share.not_owner', { gameId: 'game-1' })),
      );

      // Read as one they created, so a wildcard such as the Owner's
      // `manage:all` cannot share someone else's game or the server's own.
      // Whether a live game has the id is asked on this path only.
      expect(db.game.findFirst).toHaveBeenCalledWith({
        where: { id: 'game-1', deletedAt: null, createdById: 'owner-1' },
        select: { id: true, deletedAt: true, createdById: true },
      });
      expect(db.game.count).toHaveBeenCalledWith({ where: { id: 'game-1', deletedAt: null } });
      expect(abilityService.assertCurrentActorCan).not.toHaveBeenCalled();
      expect(abilityService.currentActorCan).not.toHaveBeenCalled();
      expect(db.gameShare.create).not.toHaveBeenCalled();
    });

    it('answers 404 for a game that is missing or soft-deleted, before asking anything', async () => {
      db.game.findFirst.mockResolvedValue(null);
      db.game.count.mockResolvedValue(0);

      await expect(service.create('game-1', toUser)).rejects.toEqual(
        new NotFoundException(t('errors.game.not_found', { id: 'game-1' })),
      );

      expect(abilityService.assertCurrentActorCan).not.toHaveBeenCalled();
      expect(abilityService.currentActorCan).not.toHaveBeenCalled();
      expect(db.gameShare.create).not.toHaveBeenCalled();
    });

    describe('to a user', () => {
      it('shares in effect at once, after asking about a share of the game to a user, and takes no lock', async () => {
        await expect(service.create('game-1', toUser)).resolves.toMatchObject({ id: 'share-1', approvedAt: NOW });

        // The game was found, so whether it exists is never asked.
        expect(db.game.count).not.toHaveBeenCalled();
        expect(db.user.findUnique).toHaveBeenCalledWith({
          where: { id: 'user-2', ...HUMAN_USER_WHERE },
          select: { id: true },
        });
        expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.create, ResourceType.GameShare, {
          householdId: null,
          userId: 'user-2',
          game: { deletedAt: null, createdById: 'owner-1' },
        });
        expect(createdWith()).toEqual({
          data: {
            gameId: 'game-1',
            userId: 'user-2',
            householdId: null,
            sharedById: 'owner-1',
            approvedAt: NOW,
            createdAt: NOW,
          },
        });
        expect(db.$queryRaw).not.toHaveBeenCalled();
      });

      it('answers 404 for a recipient who is not a registered user', async () => {
        db.user.findUnique.mockResolvedValue(null);

        await expect(service.create('game-1', toUser)).rejects.toBeInstanceOf(NotFoundException);

        expect(db.gameShare.create).not.toHaveBeenCalled();
      });

      it('refuses the acting user as their own recipient with 400', async () => {
        db.user.findUnique.mockResolvedValue(resolves({ id: 'owner-1' }));

        await expect(service.create('game-1', { userId: 'owner-1' })).rejects.toBeInstanceOf(BadRequestException);

        expect(db.gameShare.create).not.toHaveBeenCalled();
      });

      it('refuses with 403 when a block stands between the two, whichever placed it', async () => {
        db.user.count.mockResolvedValue(1);

        await expect(service.create('game-1', toUser)).rejects.toBeInstanceOf(ForbiddenException);

        // The read rule's own definition of a block, so the create and the
        // rule's veto agree on it.
        expect(db.user.count).toHaveBeenCalledWith({ where: { id: 'user-2', ...blockWith('owner-1') } });
        expect(abilityService.assertCurrentActorCan).not.toHaveBeenCalled();
        expect(db.gameShare.create).not.toHaveBeenCalled();
      });
    });

    describe('to a household', () => {
      it('asks about the household before the lock, and again of the roster read under it', async () => {
        // Logged by hand: the database double's mocks do not share the call
        // counter the other doubles use, so `invocationCallOrder` cannot order
        // them against each other.
        const steps: string[] = [];
        db.game.findFirst.mockImplementation((() => {
          steps.push('game');
          return Promise.resolve(GAME);
        }) as never);
        db.household.findUnique.mockImplementation((() => {
          steps.push('household');
          return Promise.resolve({ settings: SETTINGS, members: ROSTER });
        }) as never);
        db.$queryRaw.mockImplementation((() => {
          steps.push('lock');
          return Promise.resolve([{ id: 'hh-1' }]);
        }) as never);
        abilityService.currentActorCan.mockImplementation(() => {
          steps.push('check');
          return true;
        });
        db.gameShare.create.mockImplementation((() => {
          steps.push('insert');
          return Promise.resolve(shareRow({ userId: null, householdId: 'hh-1' }));
        }) as never);

        await service.create('game-1', toHousehold);

        expect(steps).toEqual(['game', 'household', 'check', 'lock', 'household', 'check', 'insert']);
        // The roster and the policy in one read, each time.
        expect(db.household.findUnique).toHaveBeenCalledWith({
          where: { id: 'hh-1' },
          select: {
            settings: { select: { memberSharePolicy: true } },
            members: { select: { userId: true, role: { select: { role: { select: { name: true } } } } } },
          },
        });
        expect(abilityService.currentActorCan.mock.calls).toEqual([
          [Action.create, ResourceType.GameShare, householdInstance(NOW)],
          [Action.create, ResourceType.GameShare, householdInstance(NOW)],
        ]);
        expect(createdWith()).toEqual({
          data: {
            gameId: 'game-1',
            userId: null,
            householdId: 'hh-1',
            sharedById: 'owner-1',
            approvedAt: NOW,
            createdAt: NOW,
          },
        });
      });

      it('asks whether the share may take effect at once before whether it may wait, and files it waiting only then', async () => {
        abilityService.currentActorCan.mockReturnValue(false);

        await service.create('game-1', toHousehold);

        // Asked in effect first: the owner's and the member-direct rules don't
        // read `approvedAt`, so a waiting share asked first would pass them.
        expect(abilityService.currentActorCan.mock.calls).toEqual([
          [Action.create, ResourceType.GameShare, householdInstance(NOW)],
          [Action.create, ResourceType.GameShare, householdInstance(NOW)],
        ]);
        expect(abilityService.assertCurrentActorCan.mock.calls).toEqual([
          [Action.create, ResourceType.GameShare, householdInstance(null)],
          [Action.create, ResourceType.GameShare, householdInstance(null)],
        ]);
        expect(createdWith()?.data).toMatchObject({ approvedAt: null });
      });

      it('decides from the answer under the lock, where a policy change that landed first is seen', async () => {
        abilityService.currentActorCan.mockReturnValueOnce(true).mockReturnValueOnce(false);

        await service.create('game-1', toHousehold);

        expect(createdWith()?.data).toMatchObject({ approvedAt: null });
      });

      it('refuses a member with 403 when the policy lets them do neither, before taking the lock', async () => {
        abilityService.currentActorCan.mockReturnValue(false);
        abilityService.assertCurrentActorCan.mockImplementation(() => {
          throw new ForbiddenException();
        });

        await expect(service.create('game-1', toHousehold)).rejects.toBeInstanceOf(ForbiddenException);

        expect(db.$queryRaw).not.toHaveBeenCalled();
        expect(db.gameShare.create).not.toHaveBeenCalled();
      });

      it("answers 404 for a household the acting user isn't in, before asking or locking", async () => {
        db.household.findUnique.mockResolvedValue(
          resolves({ settings: SETTINGS, members: [rosterRow('someone-else', SystemRole.HouseholdOwner)] }),
        );

        await expect(service.create('game-1', toHousehold)).rejects.toBeInstanceOf(NotFoundException);

        // A wildcard passes every question, so the roster is what refuses it.
        expect(abilityService.currentActorCan).not.toHaveBeenCalled();
        expect(db.$queryRaw).not.toHaveBeenCalled();
        expect(db.gameShare.create).not.toHaveBeenCalled();
      });

      it('answers 404 for a missing household, which reads as an empty roster', async () => {
        db.household.findUnique.mockResolvedValue(null);

        await expect(service.create('game-1', toHousehold)).rejects.toBeInstanceOf(NotFoundException);

        expect(db.$queryRaw).not.toHaveBeenCalled();
      });

      it('answers 404 for a deleted household, at the lock, and writes nothing', async () => {
        db.$queryRaw.mockResolvedValue([] as never);

        await expect(service.create('game-1', toHousehold)).rejects.toBeInstanceOf(NotFoundException);

        expect(abilityService.currentActorCan).toHaveBeenCalledTimes(1);
        expect(db.gameShare.create).not.toHaveBeenCalled();
      });

      it('answers 404 when the acting user left the household before the lock', async () => {
        db.household.findUnique
          .mockResolvedValueOnce(resolves({ settings: SETTINGS, members: ROSTER }))
          .mockResolvedValueOnce(resolves({ settings: SETTINGS, members: [ROSTER[1]] }));

        await expect(service.create('game-1', toHousehold)).rejects.toBeInstanceOf(NotFoundException);

        expect(abilityService.currentActorCan).toHaveBeenCalledTimes(1);
        expect(db.gameShare.create).not.toHaveBeenCalled();
      });

      it('asks with no settings when the household has no settings row, which no member permission matches', async () => {
        db.household.findUnique.mockResolvedValue(resolves({ settings: null, members: ROSTER }));

        await service.create('game-1', toHousehold);

        expect(abilityService.currentActorCan).toHaveBeenCalledWith(Action.create, ResourceType.GameShare, {
          ...householdInstance(NOW),
          household: { settings: null, members: ROSTER },
        });
      });
    });

    it.each([
      ['user', toUser],
      ['household', toHousehold],
    ])('maps a second share to the same %s, the unique index refusing it, to 409', async (_label, dto) => {
      db.gameShare.create.mockRejectedValue(uniqueViolation());

      await expect(service.create('game-1', dto)).rejects.toBeInstanceOf(ConflictException);

      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('answers 404 for a user whose account was deleted between its read and the insert, the foreign key refusing it', async () => {
      db.gameShare.create.mockRejectedValue(foreignKeyViolation());
      db.game.count.mockResolvedValue(1);

      await expect(service.create('game-1', toUser)).rejects.toEqual(
        new NotFoundException(t('errors.user.not_found', { id: 'user-2' })),
      );

      expect(emitter.emit).not.toHaveBeenCalled();
    });

    // #810: the game is read without a lock, and deleting one removes its row,
    // so the insert's foreign key is what finds it gone.
    it.each([
      ['user', toUser],
      ['household', toHousehold],
    ])(
      'answers 404 for the game when it was deleted between its read and the insert of a share to a %s',
      async (_label, dto) => {
        db.gameShare.create.mockRejectedValue(foreignKeyViolation());
        db.game.count.mockResolvedValue(0);

        await expect(service.create('game-1', dto)).rejects.toEqual(
          new NotFoundException(t('errors.game.not_found', { id: 'game-1' })),
        );

        // Any game by the id, deleted or not: only a removed row fails the key.
        expect(db.game.count).toHaveBeenCalledWith({ where: { id: 'game-1' } });
        expect(emitter.emit).not.toHaveBeenCalled();
      },
    );

    it('leaves a foreign key failure on a household share as it is when the game is still there: no user was named', async () => {
      const failure = foreignKeyViolation();
      db.gameShare.create.mockRejectedValue(failure);
      db.game.count.mockResolvedValue(1);

      await expect(service.create('game-1', toHousehold)).rejects.toBe(failure);
    });

    it('emits the created event after the transaction resolves', async () => {
      const steps: string[] = [];
      loggingCommit(steps);
      db.gameShare.create.mockImplementation((() => {
        steps.push('insert');
        return Promise.resolve(shareRow());
      }) as never);
      emitter.emit.mockImplementation(() => steps.push('emit'));

      await service.create('game-1', toUser);

      expect(steps).toEqual(['insert', 'commit', 'emit']);
      expect(emitter.emit).toHaveBeenCalledWith(GameShareEvents.Created, expect.any(GameShareCreatedEvent));

      const event = emitter.emit.mock.calls[0]?.[1] as GameShareCreatedEvent;
      expect(event).toMatchObject({ subject: ResourceType.GameShare, subjectId: 'share-1', before: null });
      expect(event.after).toEqual({
        id: 'share-1',
        gameId: 'game-1',
        userId: 'user-2',
        householdId: null,
        sharedById: 'owner-1',
        approvedById: null,
        approvedAt: NOW,
      });
      expect(event.action).toBe('create');
    });

    it('emits nothing when the transaction fails', async () => {
      db.gameShare.create.mockRejectedValue(new Error('connection reset'));

      await expect(service.create('game-1', toUser)).rejects.toThrow('connection reset');

      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    const householdShare = shareRow({ userId: null, householdId: 'hh-1' });

    it("answers 404 for a share this game doesn't have", async () => {
      db.gameShare.findFirst.mockResolvedValue(null);

      await expect(service.delete('game-1', 'share-1')).rejects.toBeInstanceOf(NotFoundException);

      expect(db.gameShare.findFirst).toHaveBeenCalledWith({ where: { id: 'share-1', gameId: 'game-1' } });
      expect(db.gameShare.delete).not.toHaveBeenCalled();
    });

    it('removes a share to a user after asking about it, and takes no household lock', async () => {
      await service.delete('game-1', 'share-1');

      expect(abilityService.assertCurrentActorCan.mock.calls).toEqual([
        [Action.delete, ResourceType.GameShare, { id: 'share-1', sharedById: 'owner-1', householdId: null }],
      ]);
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(db.gameShare.delete).toHaveBeenCalledWith({ where: { id: 'share-1' } });
    });

    it('refuses a caller with no say over the share with 403, and removes nothing', async () => {
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(service.delete('game-1', 'share-1')).rejects.toBeInstanceOf(ForbiddenException);

      expect(db.gameShare.delete).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    /** The question that lets a sharer remove their own share into a household: the share alone, no roster. */
    const sharerInstance = { id: 'share-1', sharedById: 'owner-1', householdId: 'hh-1' };

    it("removes the sharer's own share into a household with no roster read and no lock, even once it is deleted", async () => {
      db.gameShare.findFirst.mockResolvedValue(householdShare);
      // A deleted household: the lock would answer 404, had it been taken.
      db.$queryRaw.mockResolvedValue([] as never);

      await service.delete('game-1', 'share-1');

      expect(abilityService.currentActorCan.mock.calls).toEqual([
        [Action.delete, ResourceType.GameShare, sharerInstance],
      ]);
      expect(abilityService.assertCurrentActorCan).not.toHaveBeenCalled();
      expect(db.householdMember.findMany).not.toHaveBeenCalled();
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(db.gameShare.delete).toHaveBeenCalledWith({ where: { id: 'share-1' } });
      expect(emitter.emit).toHaveBeenCalledWith(GameShareEvents.Deleted, expect.any(GameShareDeletedEvent));
    });

    it('asks anyone but the sharer about a share to a household before the lock, and again of the roster read under it', async () => {
      const steps: string[] = [];
      db.gameShare.findFirst.mockImplementation((() => {
        steps.push('share');
        return Promise.resolve(householdShare);
      }) as never);
      abilityService.currentActorCan.mockImplementation(() => {
        steps.push('sharer');
        return false;
      });
      db.householdMember.findMany.mockImplementation((() => {
        steps.push('roster');
        return Promise.resolve(ROSTER);
      }) as never);
      db.$queryRaw.mockImplementation((() => {
        steps.push('lock');
        return Promise.resolve([{ id: 'hh-1' }]);
      }) as never);
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        steps.push('check');
      });
      db.gameShare.delete.mockImplementation((() => {
        steps.push('delete');
        return Promise.resolve(householdShare);
      }) as never);

      await service.delete('game-1', 'share-1');

      expect(steps).toEqual(['share', 'sharer', 'roster', 'check', 'lock', 'roster', 'check', 'delete']);
      expect(abilityService.currentActorCan).toHaveBeenCalledWith(
        Action.delete,
        ResourceType.GameShare,
        sharerInstance,
      );
      expect(db.householdMember.findMany).toHaveBeenCalledWith({
        where: { householdId: 'hh-1' },
        select: { userId: true, role: { select: { role: { select: { name: true } } } } },
      });
      const instance = {
        id: 'share-1',
        sharedById: 'owner-1',
        householdId: 'hh-1',
        household: { members: ROSTER },
      };
      expect(abilityService.assertCurrentActorCan.mock.calls).toEqual([
        [Action.delete, ResourceType.GameShare, instance],
        [Action.delete, ResourceType.GameShare, instance],
      ]);
    });

    it("answers 404 to a household owner or admin removing someone else's share to a deleted household, at the lock", async () => {
      db.gameShare.findFirst.mockResolvedValue(householdShare);
      abilityService.currentActorCan.mockReturnValue(false);
      db.$queryRaw.mockResolvedValue([] as never);

      await expect(service.delete('game-1', 'share-1')).rejects.toBeInstanceOf(NotFoundException);

      expect(db.gameShare.delete).not.toHaveBeenCalled();
    });

    it('answers 404 for a share removed by someone else since it was read', async () => {
      db.gameShare.delete.mockRejectedValue(dependentRecordNotFound());

      await expect(service.delete('game-1', 'share-1')).rejects.toBeInstanceOf(NotFoundException);

      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('emits the deleted event after the transaction resolves', async () => {
      const steps: string[] = [];
      loggingCommit(steps);
      db.gameShare.delete.mockImplementation((() => {
        steps.push('delete');
        return Promise.resolve(shareRow());
      }) as never);
      emitter.emit.mockImplementation(() => steps.push('emit'));

      await service.delete('game-1', 'share-1');

      expect(steps).toEqual(['delete', 'commit', 'emit']);
      expect(emitter.emit).toHaveBeenCalledWith(GameShareEvents.Deleted, expect.any(GameShareDeletedEvent));

      const event = emitter.emit.mock.calls[0]?.[1] as GameShareDeletedEvent;
      expect(event).toMatchObject({ subject: ResourceType.GameShare, subjectId: 'share-1', after: null });
      expect(event.before).toMatchObject({ id: 'share-1', gameId: 'game-1', userId: 'user-2' });
      expect(event.action).toBe('delete');
    });

    it('emits nothing when the transaction fails', async () => {
      db.gameShare.delete.mockRejectedValue(new Error('connection reset'));

      await expect(service.delete('game-1', 'share-1')).rejects.toThrow('connection reset');

      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('listForGame', () => {
    it("composes the read ceiling with the game's shares, rows and total from one snapshot", async () => {
      db.gameShare.findMany.mockResolvedValue([shareRow()]);
      db.gameShare.count.mockResolvedValue(1);

      await expect(service.listForGame('game-1', paginationQuery({ page: 2, limit: 10 }))).resolves.toEqual({
        rows: [shareRow()],
        total: 1,
      });

      expect(compose).toHaveBeenCalledWith(ResourceType.GameShare, Action.read, { gameId: 'game-1' });
      const where = { gameId: 'game-1', AND: [COND] };
      expect(db.gameShare.findMany).toHaveBeenCalledWith({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 10,
        take: 10,
      });
      expect(db.gameShare.count).toHaveBeenCalledWith({ where });
      expect(batchTransactionCall(db).options).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
    });
  });
});
