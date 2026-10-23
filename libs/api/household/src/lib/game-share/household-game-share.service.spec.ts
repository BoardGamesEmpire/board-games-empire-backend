import { Action, MemberSharePolicy, Prisma, ResourceType, SystemRole, type GameShare } from '@bge/database';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import {
  batchTransactionCall,
  createTestingModuleWithDb,
  paginationQuery,
  unwrapTransaction,
  type MockDatabaseService,
} from '@bge/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Http } from '@status/codes';
import { HouseholdEvents } from '../constants/household-events.constant';
import { HouseholdGameShareApprovedEvent } from '../events/household.events';
import { HouseholdGameShareService } from './household-game-share.service';

const COND = { id: 'sentinel-condition' };
const CREATED = new Date('2026-10-20T12:00:00Z');

type RosterRow = { userId: string; role: { role: { name: string } } | null };

const rosterRow = (userId: string, name: SystemRole): RosterRow => ({ userId, role: { role: { name } } });

const ROSTER: RosterRow[] = [
  rosterRow('owner-1', SystemRole.HouseholdOwner),
  rosterRow('member-1', SystemRole.HouseholdMember),
];

/** Prisma's delegate types want full rows; the service selects narrower ones. */
const resolves = (value: unknown) => value as never;

/** A member's share into `hh-1`, as stored once it is approved. */
const approvedRow = (approvedAt: Date): GameShare => ({
  id: 'share-1',
  gameId: 'game-1',
  userId: null,
  householdId: 'hh-1',
  sharedById: 'member-1',
  approvedById: 'owner-1',
  approvedAt,
  createdAt: CREATED,
});

describe('HouseholdGameShareService', () => {
  let service: HouseholdGameShareService;
  let db: MockDatabaseService;
  let abilityService: jest.Mocked<
    Pick<
      AbilityService,
      'getActingUserId' | 'assertCurrentActorCan' | 'getCurrentResourceConditions' | 'userAbilityWithin'
    >
  >;
  /** The sharer's own ability, as `userAbilityWithin` loads it. */
  let sharerCan: jest.Mock;
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    sharerCan = jest.fn().mockReturnValue(true);
    abilityService = {
      getActingUserId: jest.fn().mockReturnValue('owner-1'),
      assertCurrentActorCan: jest.fn(),
      getCurrentResourceConditions: jest.fn().mockReturnValue([COND]),
      userAbilityWithin: jest.fn().mockResolvedValue(sharerCan),
    };
    emitter = { emit: jest.fn() };

    const ctx = await createTestingModuleWithDb({
      providers: [
        HouseholdGameShareService,
        // The real composer over the mocked ability service, as in
        // `household-invite.service.spec.ts`, so the where-clause assertions
        // test the merge the list depends on.
        ScopeComposer,
        { provide: AbilityService, useValue: abilityService },
        { provide: EventEmitter2, useValue: emitter },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(HouseholdGameShareService);

    unwrapTransaction(db);
    db.$queryRaw.mockResolvedValue([{ id: 'hh-1' }] as never);
    db.householdMember.findMany.mockResolvedValue(resolves(ROSTER));
    db.household.count.mockResolvedValue(1);
    db.gameShare.updateMany.mockResolvedValue({ count: 1 });
    db.householdSettings.findUnique.mockResolvedValue(resolves({ memberSharePolicy: MemberSharePolicy.NeedsApproval }));
    db.game.findUniqueOrThrow.mockResolvedValue(resolves({ deletedAt: null, createdById: 'member-1' }));
    // The write's own `approvedAt`, as the read after it sees it.
    db.gameShare.findFirst.mockImplementation(((): Promise<GameShare> => {
      const data = db.gameShare.updateMany.mock.calls[0]?.[0]?.data as { approvedAt: Date } | undefined;

      return Promise.resolve(approvedRow(data?.approvedAt ?? CREATED));
    }) as never);
  });

  afterEach(() => jest.clearAllMocks());

  describe('approve (#810)', () => {
    /** Records each step of the transaction, in order, into `steps`. */
    const recordSteps = (steps: string[]) => {
      db.$queryRaw.mockImplementation((() => {
        steps.push('lock');
        return Promise.resolve([{ id: 'hh-1' }]);
      }) as never);
      db.householdMember.findMany.mockImplementation((() => {
        steps.push('roster');
        return Promise.resolve(ROSTER);
      }) as never);
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        steps.push('check');
      });
      db.gameShare.updateMany.mockImplementation((() => {
        steps.push('write');
        return Promise.resolve({ count: 1 });
      }) as never);
      db.gameShare.findFirst.mockImplementation((() => {
        steps.push('read');
        return Promise.resolve(approvedRow(CREATED));
      }) as never);
      abilityService.userAbilityWithin.mockImplementation(() => {
        steps.push('sharer');
        return Promise.resolve(sharerCan);
      });
    };

    it('asks about approving a share of the household before the lock, and again of the roster read under it', async () => {
      const steps: string[] = [];
      recordSteps(steps);

      await service.approve('hh-1', 'share-1');

      expect(steps).toEqual(['roster', 'check', 'lock', 'roster', 'check', 'write', 'read', 'sharer']);
      // Asked about `approvedAt`, the column only an approval writes, of the
      // share's id and the household's roster. The member share policy is the
      // sharer's question, not the approver's.
      const instance = { id: 'share-1', householdId: 'hh-1', household: { members: ROSTER } };
      expect(abilityService.assertCurrentActorCan.mock.calls).toEqual([
        [Action.update, ResourceType.GameShare, instance, 'approvedAt'],
        [Action.update, ResourceType.GameShare, instance, 'approvedAt'],
      ]);
      expect(db.householdMember.findMany).toHaveBeenCalledWith({
        where: { householdId: 'hh-1' },
        select: { userId: true, role: { select: { role: { select: { name: true } } } } },
      });
    });

    it('writes the approval only while the share still waits, bound to the household, with no limit', async () => {
      const before = Date.now();

      const share = await service.approve('hh-1', 'share-1');

      expect(db.gameShare.updateMany).toHaveBeenCalledTimes(1);
      const [[args]] = db.gameShare.updateMany.mock.calls;
      // No `limit`: with one, Prisma moves the guard into a subquery that a
      // concurrent approval's commit does not recheck.
      expect(args).toEqual({
        where: { id: 'share-1', householdId: 'hh-1', approvedAt: null },
        data: { approvedAt: expect.any(Date), approvedById: 'owner-1' },
      });
      const approvedAt = (args?.data as { approvedAt: Date }).approvedAt.getTime();
      expect(approvedAt).toBeGreaterThanOrEqual(before);
      expect(approvedAt).toBeLessThanOrEqual(Date.now());
      expect(db.gameShare.findFirst).toHaveBeenCalledWith({ where: { id: 'share-1', householdId: 'hh-1' } });
      expect(share).toEqual(approvedRow(new Date(approvedAt)));
    });

    // The question an invite's approval asks of its sender (#747): could the
    // sharer make this share now, in effect or for approval?
    it('asks whether the sharer could still share it, of the roster read under the lock and the policy now', async () => {
      const underLock = [...ROSTER, rosterRow('admin-1', SystemRole.HouseholdAdmin)];
      db.householdMember.findMany.mockResolvedValueOnce(resolves(ROSTER)).mockResolvedValueOnce(resolves(underLock));
      // Not in effect at once, as a member under `NeedsApproval` may not share.
      sharerCan.mockReturnValueOnce(false);

      await service.approve('hh-1', 'share-1');

      expect(abilityService.userAbilityWithin).toHaveBeenCalledWith(db, 'member-1');
      expect(db.householdSettings.findUnique).toHaveBeenCalledWith({
        where: { householdId: 'hh-1' },
        select: { memberSharePolicy: true },
      });
      expect(db.game.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 'game-1' },
        select: { deletedAt: true, createdById: true },
      });
      const instance = (approvedAt: Date | null) => ({
        householdId: 'hh-1',
        approvedAt,
        game: { deletedAt: null, createdById: 'member-1' },
        household: { settings: { memberSharePolicy: MemberSharePolicy.NeedsApproval }, members: underLock },
      });
      expect(sharerCan.mock.calls).toEqual([
        [Action.create, ResourceType.GameShare, instance(expect.any(Date))],
        [Action.create, ResourceType.GameShare, instance(null)],
      ]);
      expect(emitter.emit).toHaveBeenCalledTimes(1);
    });

    it('asks no second question when the sharer could still share it in effect', async () => {
      await service.approve('hh-1', 'share-1');

      expect(sharerCan).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['could share it neither way, as after a demotion to guest or a switch to Off', {}, true],
      ['is no longer on the roster read under the lock', { roster: [ROSTER[0]] }, false],
      ['was deleted, which empties sharedById', { sharedById: null }, false],
    ] as const)(
      'answers 409 and announces nothing when the sharer %s',
      async (_label, arrange: { roster?: readonly RosterRow[]; sharedById?: null }, asksTheSharer) => {
        sharerCan.mockReturnValue(false);
        if (arrange.roster) {
          db.householdMember.findMany
            .mockResolvedValueOnce(resolves(ROSTER))
            .mockResolvedValueOnce(resolves(arrange.roster));
        }
        if (arrange.sharedById === null) {
          db.gameShare.findFirst.mockResolvedValue({ ...approvedRow(CREATED), sharedById: null });
        }

        await expect(service.approve('hh-1', 'share-1')).rejects.toMatchObject({
          status: Http.Conflict,
          response: expect.objectContaining({ key: 'errors.game_share.sharer_cannot_share' }),
        });

        expect(abilityService.userAbilityWithin).toHaveBeenCalledTimes(asksTheSharer ? 1 : 0);
        expect(emitter.emit).not.toHaveBeenCalled();
      },
    );

    it('refuses an actor with no say here with 403 before taking the lock, and writes nothing', async () => {
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(service.approve('hh-1', 'share-1')).rejects.toBeInstanceOf(ForbiddenException);

      expect(db.$queryRaw).not.toHaveBeenCalled();
      // Asked before the share is read, so the answer says nothing about
      // whether the household has a share by that id.
      expect(db.gameShare.findFirst).not.toHaveBeenCalled();
      expect(db.gameShare.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('decides from the roster read under the lock, where a demotion that landed first is seen', async () => {
      const demoted = [rosterRow('owner-1', SystemRole.HouseholdMember)];
      db.householdMember.findMany.mockResolvedValueOnce(resolves(ROSTER)).mockResolvedValueOnce(resolves(demoted));
      abilityService.assertCurrentActorCan.mockImplementation((_action, _type, instance) => {
        if ((instance as { household: { members: RosterRow[] } }).household.members === demoted) {
          throw new ForbiddenException();
        }
      });

      await expect(service.approve('hh-1', 'share-1')).rejects.toBeInstanceOf(ForbiddenException);

      expect(db.$queryRaw).toHaveBeenCalledTimes(1);
      expect(db.gameShare.updateMany).not.toHaveBeenCalled();
    });

    it('answers 404 for a missing or deleted household, and writes nothing', async () => {
      db.$queryRaw.mockResolvedValue([] as never);

      await expect(service.approve('hh-1', 'share-1')).rejects.toBeInstanceOf(NotFoundException);

      expect(db.gameShare.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('answers 409 when the guard wrote nothing to a share the household has, which is already in effect', async () => {
      db.gameShare.updateMany.mockResolvedValue({ count: 0 });
      db.gameShare.findFirst.mockResolvedValue(approvedRow(CREATED));

      await expect(service.approve('hh-1', 'share-1')).rejects.toMatchObject({
        status: Http.Conflict,
        response: expect.objectContaining({ key: 'errors.game_share.not_awaiting_approval' }),
      });

      expect(emitter.emit).not.toHaveBeenCalled();
    });

    // Read after the write, so a share its sharer removed while this approval
    // waited for the lock answers 404 rather than 409.
    it.each([
      ['wrote nothing', 0],
      ['matched a row the read then misses', 1],
    ])('answers 404 when the household has no such share, though the guard %s', async (_label, count) => {
      db.gameShare.updateMany.mockResolvedValue({ count });
      db.gameShare.findFirst.mockResolvedValue(null);

      await expect(service.approve('hh-1', 'share-1')).rejects.toMatchObject({
        status: Http.NotFound,
        response: expect.objectContaining({ key: 'errors.game_share.not_found_in_household' }),
      });

      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('announces the approval after the transaction, with the share before and after it', async () => {
      const steps: string[] = [];
      recordSteps(steps);
      db.$transaction.mockImplementation((async (work: (tx: MockDatabaseService) => Promise<unknown>) => {
        const result = await work(db);
        steps.push('commit');

        return result;
      }) as never);
      emitter.emit.mockImplementation(() => steps.push('emit'));

      await service.approve('hh-1', 'share-1');

      expect(steps.slice(-4)).toEqual(['read', 'sharer', 'commit', 'emit']);
      expect(emitter.emit).toHaveBeenCalledWith(
        HouseholdEvents.GameShareApproved,
        expect.any(HouseholdGameShareApprovedEvent),
      );

      const event = emitter.emit.mock.calls[0]?.[1] as HouseholdGameShareApprovedEvent;
      expect(event).toMatchObject({ subject: ResourceType.GameShare, subjectId: 'share-1', action: 'update' });
      const columns = {
        id: 'share-1',
        gameId: 'game-1',
        userId: null,
        householdId: 'hh-1',
        sharedById: 'member-1',
      };
      expect(event.before).toEqual({ ...columns, approvedById: null, approvedAt: null });
      expect(event.after).toEqual({ ...columns, approvedById: 'owner-1', approvedAt: CREATED });
    });

    it('announces nothing when the transaction fails', async () => {
      db.gameShare.updateMany.mockRejectedValue(new Error('connection reset'));

      await expect(service.approve('hh-1', 'share-1')).rejects.toThrow('connection reset');

      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('listShares (#810)', () => {
    const query = () => paginationQuery({ limit: 10 });

    beforeEach(() => {
      db.gameShare.findMany.mockResolvedValue(resolves([]));
      db.gameShare.count.mockResolvedValue(0);
    });

    it('asks about reading THIS household’s shares, and refuses before reading any', async () => {
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(service.listShares('hh-1', query())).rejects.toBeInstanceOf(ForbiddenException);

      // A read changes no column, so it names none, and no share.
      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(
        Action.read,
        ResourceType.GameShare,
        { householdId: 'hh-1', household: { members: ROSTER } },
        undefined,
      );
      expect(db.gameShare.findMany).not.toHaveBeenCalled();
    });

    it('answers 404 for a missing household only to a caller who may read its shares', async () => {
      db.household.count.mockResolvedValue(0);

      await expect(service.listShares('hh-1', query())).rejects.toBeInstanceOf(NotFoundException);

      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });
      db.household.count.mockClear();

      await expect(service.listShares('hh-1', query())).rejects.toBeInstanceOf(ForbiddenException);
      expect(db.household.count).not.toHaveBeenCalled();
    });

    it('lists the household’s shares under the caller’s read ceiling, newest first in one snapshot, each naming its game', async () => {
      const row = { ...approvedRow(CREATED), game: { id: 'game-1', title: 'Azul', thumbnail: null } };
      db.gameShare.findMany.mockResolvedValue(resolves([row]));
      db.gameShare.count.mockResolvedValue(1);

      await expect(service.listShares('hh-1', query())).resolves.toEqual({ rows: [row], total: 1 });

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.GameShare, Action.read);
      const where = { householdId: 'hh-1', AND: [COND] };
      expect(db.gameShare.findMany).toHaveBeenCalledWith({
        where,
        select: {
          id: true,
          gameId: true,
          userId: true,
          householdId: true,
          sharedById: true,
          approvedById: true,
          approvedAt: true,
          createdAt: true,
          game: { select: { id: true, title: true, thumbnail: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 0,
        take: 10,
      });
      expect(db.gameShare.count).toHaveBeenCalledWith({ where });
      expect(batchTransactionCall(db).options).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
    });
  });
});
