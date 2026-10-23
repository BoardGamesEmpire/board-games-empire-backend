import { Action, HUMAN_USER_WHERE, Prisma, ResourceType, SystemRole } from '@bge/database';
import { InviteService, type InviteDomainEvent } from '@bge/invites';
import { AbilityService, PermissionsService, ScopeComposer } from '@bge/permissions';
import {
  batchTransactionCall,
  createTestingModuleWithDb,
  paginationQuery,
  rawQueryText,
  unwrapTransaction,
  type MockDatabaseService,
} from '@bge/testing';
import { ForbiddenException } from '@nestjs/common';
import { Http, PrismaError } from '@status/codes';
import { HouseholdMemberService, type RemovedMembership } from '../member/household-member.service';
import { HOUSEHOLD_BAN_SELECT } from './household-ban.read-shape';
import { HouseholdBanService } from './household-ban.service';

const COND = { id: 'sentinel-condition' };
const NOW = new Date('2026-10-23T12:00:00Z');
const LATER = new Date('2026-10-24T12:00:00Z');

type RosterRow = { userId: string; role: { role: { name: string } } | null };

const rosterRow = (userId: string, name: SystemRole): RosterRow => ({ userId, role: { role: { name } } });

const ROSTER: RosterRow[] = [
  rosterRow('owner-1', SystemRole.HouseholdOwner),
  rosterRow('user-2', SystemRole.HouseholdMember),
];

/** The instance every ban route asks about: the household's roster, read in full. */
const BAN_INSTANCE = { householdId: 'hh-1', household: { members: ROSTER } };

const BAN_ROW = {
  id: 'ban-1',
  householdId: 'hh-1',
  reason: 'Kept the good meeples',
  createdAt: NOW,
  updatedAt: NOW,
  user: { id: 'user-2', username: 'sam', profile: { displayName: 'Sam Doe' } },
  bannedBy: { id: 'owner-1', username: 'olive', profile: null },
};

const BAN_VIEW = {
  id: 'ban-1',
  householdId: 'hh-1',
  reason: 'Kept the good meeples',
  createdAt: NOW,
  updatedAt: NOW,
  user: { id: 'user-2', name: 'Sam Doe' },
  bannedBy: { id: 'owner-1', name: 'olive' },
};

const REVOKED = [{ eventName: 'invite.revoked', subjectId: 'inv-1' }] as unknown as InviteDomainEvent[];

const resolves = (value: unknown) => value as never;

const dependentRecordNotFound = () =>
  new Prisma.PrismaClientKnownRequestError('no rows', {
    code: PrismaError.DependentRecordNotFound,
    clientVersion: 'test',
  });

const isShareLockSql = (value: unknown): boolean => /FOR SHARE/.test(rawQueryText(value));
const isRoleTransitionLockSql = (value: unknown): boolean => /FOR NO KEY UPDATE/.test(rawQueryText(value));

describe('HouseholdBanService', () => {
  let service: HouseholdBanService;
  let db: MockDatabaseService;
  let abilityService: jest.Mocked<
    Pick<AbilityService, 'getActingUserId' | 'assertCurrentActorCan' | 'getCurrentResourceConditions'>
  >;
  let permissions: jest.Mocked<Pick<PermissionsService, 'invalidateUser'>>;
  let invites: jest.Mocked<
    Pick<InviteService, 'revokeOutstandingOfUserWithin' | 'withholdOutstandingToAddressWithin' | 'emit'>
  >;
  let members: jest.Mocked<Pick<HouseholdMemberService, 'removeUserWithin'>>;
  let compose: jest.SpyInstance;

  beforeEach(async () => {
    abilityService = {
      getActingUserId: jest.fn().mockReturnValue('owner-1'),
      assertCurrentActorCan: jest.fn(),
      getCurrentResourceConditions: jest.fn().mockReturnValue([COND]),
    };
    permissions = { invalidateUser: jest.fn().mockResolvedValue(undefined) };
    invites = {
      revokeOutstandingOfUserWithin: jest.fn().mockResolvedValue({ count: 0, events: [] }),
      withholdOutstandingToAddressWithin: jest.fn().mockResolvedValue({ count: 0 }),
      emit: jest.fn(),
    };
    members = { removeUserWithin: jest.fn().mockResolvedValue(null) };

    const ctx = await createTestingModuleWithDb({
      providers: [
        HouseholdBanService,
        // The real composer over the mocked ability service, so the list's
        // where clause asserted below is the merge the read runs.
        ScopeComposer,
        { provide: AbilityService, useValue: abilityService },
        { provide: PermissionsService, useValue: permissions },
        { provide: InviteService, useValue: invites },
        { provide: HouseholdMemberService, useValue: members },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(HouseholdBanService);
    compose = jest.spyOn(ctx.module.get(ScopeComposer), 'compose');

    unwrapTransaction(db);
    db.$queryRaw.mockResolvedValue([{ id: 'hh-1' }] as never);
    db.householdMember.findMany.mockResolvedValue(resolves(ROSTER));
    db.user.findUnique.mockResolvedValue(resolves({ id: 'user-2', email: 'sam@example.test' }));
    db.householdBan.count.mockResolvedValue(0);
    db.householdBan.create.mockResolvedValue(resolves(BAN_ROW));
  });

  afterEach(() => jest.clearAllMocks());

  describe('ban', () => {
    const DTO = { userId: 'user-2', reason: 'Kept the good meeples' };

    it('refuses to ban yourself with 400, before any read (#782)', async () => {
      await expect(service.ban('hh-1', { userId: 'owner-1' })).rejects.toMatchObject({
        status: Http.BadRequest,
        response: expect.objectContaining({ key: 'errors.household.ban_self' }),
      });

      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.householdMember.findMany).not.toHaveBeenCalled();
    });

    it("asks create on the household's ban before and after the lock (#782)", async () => {
      // Logged by hand: the database double's mocks do not share a call
      // counter with the other doubles.
      const steps: string[] = [];
      db.householdMember.findMany.mockImplementation((() => {
        steps.push('roster');
        return Promise.resolve(ROSTER);
      }) as never);
      db.$queryRaw.mockImplementation(((query: unknown) => {
        steps.push(isRoleTransitionLockSql(query) ? 'lock' : 'other lock');
        return Promise.resolve([{ id: 'hh-1' }]);
      }) as never);
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        steps.push('check');
      });

      await service.ban('hh-1', DTO);

      // The role-transition lock, which removing a member takes and an admission waits on.
      expect(steps.slice(0, 5)).toEqual(['roster', 'check', 'lock', 'roster', 'check']);
      expect(abilityService.assertCurrentActorCan.mock.calls).toEqual([
        [Action.create, ResourceType.HouseholdBan, BAN_INSTANCE],
        [Action.create, ResourceType.HouseholdBan, BAN_INSTANCE],
      ]);
      expect(db.householdMember.findMany).toHaveBeenCalledWith({
        where: { householdId: 'hh-1' },
        select: { userId: true, role: { select: { role: { select: { name: true } } } } },
      });
    });

    it("refuses an actor who isn't an owner or admin with 403, before the lock (#782)", async () => {
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(service.ban('hh-1', DTO)).rejects.toBeInstanceOf(ForbiddenException);

      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(db.user.findUnique).not.toHaveBeenCalled();
      expect(db.householdBan.create).not.toHaveBeenCalled();
    });

    it("answers 404 for an unknown user or one who isn't a registered user (#782)", async () => {
      db.user.findUnique.mockResolvedValue(null);

      await expect(service.ban('hh-1', DTO)).rejects.toMatchObject({
        status: Http.NotFound,
        response: expect.objectContaining({ key: 'errors.user.not_found' }),
      });

      expect(db.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-2', ...HUMAN_USER_WHERE },
        select: { id: true, email: true },
      });
      expect(members.removeUserWithin).not.toHaveBeenCalled();
      expect(db.householdBan.create).not.toHaveBeenCalled();
    });

    it('answers 409 when the user is already banned, and writes nothing (#782)', async () => {
      db.householdBan.count.mockResolvedValue(1);

      await expect(service.ban('hh-1', DTO)).rejects.toMatchObject({
        status: Http.Conflict,
        response: expect.objectContaining({ key: 'errors.household.already_banned' }),
      });

      expect(db.householdBan.count).toHaveBeenCalledWith({ where: { householdId: 'hh-1', userId: 'user-2' } });
      expect(members.removeUserWithin).not.toHaveBeenCalled();
      expect(invites.revokeOutstandingOfUserWithin).not.toHaveBeenCalled();
      expect(invites.withholdOutstandingToAddressWithin).not.toHaveBeenCalled();
      expect(db.householdBan.create).not.toHaveBeenCalled();
    });

    it('bans a member: removes them, withholds their address invites, records the ban, then evicts their cache and announces the revoked invites after commit (#782)', async () => {
      const steps: string[] = [];
      members.removeUserWithin.mockImplementation(async () => {
        steps.push('remove');
        return { removed: {}, revoked: REVOKED } as unknown as RemovedMembership;
      });
      invites.withholdOutstandingToAddressWithin.mockImplementation(async () => {
        steps.push('withhold');
        return { count: 1 };
      });
      db.householdBan.create.mockImplementation((() => {
        steps.push('insert');
        return Promise.resolve(BAN_ROW);
      }) as never);
      db.$transaction.mockImplementation((async (operations: (tx: MockDatabaseService) => Promise<unknown>) => {
        const result = await operations(db);
        steps.push('commit');
        return result;
      }) as never);
      permissions.invalidateUser.mockImplementation(async () => {
        steps.push('evict');
      });
      invites.emit.mockImplementation(() => {
        steps.push('emit');
      });

      await expect(service.ban('hh-1', DTO)).resolves.toEqual(BAN_VIEW);

      expect(steps).toEqual(['remove', 'withhold', 'insert', 'commit', 'evict', 'emit']);
      expect(members.removeUserWithin).toHaveBeenCalledWith(db, 'hh-1', 'user-2');
      // Removing them revoked their invites already, as leaving does.
      expect(invites.revokeOutstandingOfUserWithin).not.toHaveBeenCalled();
      expect(invites.withholdOutstandingToAddressWithin).toHaveBeenCalledWith(
        db,
        { householdId: 'hh-1' },
        'sam@example.test',
      );
      expect(db.householdBan.create).toHaveBeenCalledWith({
        data: { householdId: 'hh-1', userId: 'user-2', bannedById: 'owner-1', reason: 'Kept the good meeples' },
        select: HOUSEHOLD_BAN_SELECT,
      });
      expect(permissions.invalidateUser).toHaveBeenCalledWith('user-2');
      expect(invites.emit).toHaveBeenCalledWith(REVOKED);
    });

    it('bans a non-member: revokes their invites by id and the ones they sent, withholds their address invites, records the ban, and evicts no cache (#782)', async () => {
      invites.revokeOutstandingOfUserWithin.mockResolvedValue({ count: 1, events: REVOKED as never });

      await expect(service.ban('hh-1', { userId: 'user-2' })).resolves.toEqual(BAN_VIEW);

      expect(invites.revokeOutstandingOfUserWithin).toHaveBeenCalledWith(db, { householdId: 'hh-1' }, 'user-2');
      expect(invites.withholdOutstandingToAddressWithin).toHaveBeenCalledWith(
        db,
        { householdId: 'hh-1' },
        'sam@example.test',
      );
      expect(db.householdBan.create).toHaveBeenCalledWith({
        data: { householdId: 'hh-1', userId: 'user-2', bannedById: 'owner-1', reason: null },
        select: HOUSEHOLD_BAN_SELECT,
      });
      expect(permissions.invalidateUser).not.toHaveBeenCalled();
      expect(invites.emit).toHaveBeenCalledWith(REVOKED);
    });

    it("leaves everything as it was when removing the member is refused, as for a household admin's ban of an admin (#782)", async () => {
      members.removeUserWithin.mockRejectedValue(new ForbiddenException());

      await expect(service.ban('hh-1', DTO)).rejects.toBeInstanceOf(ForbiddenException);

      expect(invites.withholdOutstandingToAddressWithin).not.toHaveBeenCalled();
      expect(db.householdBan.create).not.toHaveBeenCalled();
      expect(permissions.invalidateUser).not.toHaveBeenCalled();
      expect(invites.emit).not.toHaveBeenCalled();
    });
  });

  describe('updateReason and lift', () => {
    const PAIR = { householdId_userId: { householdId: 'hh-1', userId: 'user-2' } };

    beforeEach(() => {
      db.householdBan.findUnique.mockResolvedValue(resolves(BAN_ROW));
    });

    it('updateReason sets, replaces and clears the reason (#782)', async () => {
      db.householdBan.update.mockImplementation(((args: { data: { reason: string | null } }) =>
        Promise.resolve({ ...BAN_ROW, reason: args.data.reason, updatedAt: LATER })) as never);

      await expect(service.updateReason('hh-1', 'user-2', { reason: 'b' })).resolves.toEqual({
        ...BAN_VIEW,
        reason: 'b',
        updatedAt: LATER,
      });
      await expect(service.updateReason('hh-1', 'user-2', { reason: null })).resolves.toMatchObject({ reason: null });

      expect(db.householdBan.update).toHaveBeenNthCalledWith(1, {
        where: PAIR,
        data: { reason: 'b' },
        select: HOUSEHOLD_BAN_SELECT,
      });
      expect(db.householdBan.update).toHaveBeenNthCalledWith(2, {
        where: PAIR,
        data: { reason: null },
        select: HOUSEHOLD_BAN_SELECT,
      });
      // Asked before and after the household's share lock, each time.
      expect(abilityService.assertCurrentActorCan.mock.calls).toEqual(
        Array.from({ length: 4 }, () => [Action.update, ResourceType.HouseholdBan, BAN_INSTANCE]),
      );
      expect(db.$queryRaw.mock.calls.map(([query]) => isShareLockSql(query))).toEqual([true, true]);
    });

    it('updateReason and lift answer 404 when there is no ban (#782)', async () => {
      db.householdBan.findUnique.mockResolvedValue(null);

      for (const attempt of [
        () => service.updateReason('hh-1', 'user-2', { reason: 'b' }),
        () => service.lift('hh-1', 'user-2'),
      ]) {
        await expect(attempt()).rejects.toMatchObject({
          status: Http.NotFound,
          response: expect.objectContaining({ key: 'errors.household.ban_not_found' }),
        });
      }

      expect(db.householdBan.findUnique).toHaveBeenCalledWith({ where: PAIR, select: HOUSEHOLD_BAN_SELECT });
      expect(db.householdBan.update).not.toHaveBeenCalled();
      expect(db.householdBan.delete).not.toHaveBeenCalled();
    });

    // Two lifts sent at once, as a double-click sends them, both read the ban
    // under the household's share lock; the write that lands second finds it
    // gone (#782).
    it('lift answers 404, not 500, when a lift that landed first already deleted the ban (#782)', async () => {
      db.householdBan.delete.mockRejectedValue(dependentRecordNotFound());

      await expect(service.lift('hh-1', 'user-2')).rejects.toMatchObject({
        status: Http.NotFound,
        response: expect.objectContaining({ key: 'errors.household.ban_not_found' }),
      });
    });

    it('updateReason answers 404, not 500, when a lift landed first (#782)', async () => {
      db.householdBan.update.mockRejectedValue(dependentRecordNotFound());

      await expect(service.updateReason('hh-1', 'user-2', { reason: 'b' })).rejects.toMatchObject({
        status: Http.NotFound,
        response: expect.objectContaining({ key: 'errors.household.ban_not_found' }),
      });
    });

    it('passes on any other failure of the write unchanged (#782)', async () => {
      const failure = new Error('connection reset');
      db.householdBan.delete.mockRejectedValue(failure);
      db.householdBan.update.mockRejectedValue(failure);

      await expect(service.lift('hh-1', 'user-2')).rejects.toBe(failure);
      await expect(service.updateReason('hh-1', 'user-2', { reason: 'b' })).rejects.toBe(failure);
    });

    it('lift deletes the row and hands back the ban as it was (#782)', async () => {
      db.householdBan.delete.mockResolvedValue(resolves({ id: 'ban-1' }));

      await expect(service.lift('hh-1', 'user-2')).resolves.toEqual(BAN_VIEW);

      expect(db.householdBan.delete).toHaveBeenCalledWith({ where: { id: 'ban-1' } });
      expect(abilityService.assertCurrentActorCan.mock.calls).toEqual([
        [Action.delete, ResourceType.HouseholdBan, BAN_INSTANCE],
        [Action.delete, ResourceType.HouseholdBan, BAN_INSTANCE],
      ]);
      expect(db.$queryRaw.mock.calls.map(([query]) => isShareLockSql(query))).toEqual([true]);
    });
  });

  describe('list', () => {
    it('list composes the read on HouseholdBan for the household, newest first (#782)', async () => {
      db.householdBan.findMany.mockResolvedValue(resolves([BAN_ROW]));
      db.householdBan.count.mockResolvedValue(1);

      await expect(service.list('hh-1', paginationQuery({ limit: 10 }))).resolves.toEqual({
        rows: [BAN_VIEW],
        total: 1,
      });

      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(
        Action.read,
        ResourceType.HouseholdBan,
        BAN_INSTANCE,
      );
      expect(compose).toHaveBeenCalledWith(ResourceType.HouseholdBan, Action.read, { householdId: 'hh-1' });
      const where = { householdId: 'hh-1', AND: [COND] };
      expect(db.householdBan.findMany).toHaveBeenCalledWith({
        where,
        select: HOUSEHOLD_BAN_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 0,
        take: 10,
      });
      expect(db.householdBan.count).toHaveBeenCalledWith({ where });
      expect(batchTransactionCall(db).options).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
    });
  });
});
