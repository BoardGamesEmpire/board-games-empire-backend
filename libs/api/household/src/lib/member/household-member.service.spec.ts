import { Action, HouseholdMembershipOrigin, Prisma, QuotaScope, ResourceType, SystemRole } from '@bge/database';
import { AbilityService, PermissionsService } from '@bge/permissions';
import { QuotaExceededException, QuotaService, type QuotaCheckResult, type QuotaSoftOverageEvent } from '@bge/quota';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { WebhookEventType } from '@bge/webhooks';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Http, PrismaError } from '@status/codes';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HouseholdEvents } from '../constants/household-events.constant';
import { HOUSEHOLD_MEMBER_UNIQUE_CONSTRAINT } from '../constants/household.constants';
import type { AssignableHouseholdRole } from '../dto';
import {
  HouseholdMemberService,
  MEMBER_INCLUDE,
  type AdmissibleMembershipOrigin,
  type HouseholdMemberWithRelations,
} from './household-member.service';

/**
 * `Prisma.sql` exposes both `strings` and a `text` getter; reading either
 * structurally avoids depending on which the installed client version keeps.
 *
 * Module-scoped because two independent raw statements are now issued from this
 * service — the owner lock and the household share-lock — and both the
 * dispatching `$queryRaw` stub and the identifier-pinning suite need to tell
 * them apart.
 */
const rawText = (value: unknown): string => {
  const sql = value as { strings?: readonly string[]; text?: string };

  return sql.strings?.join(' ') ?? sql.text ?? '';
};

/** True for the household share-lock statement, false for the owner lock. */
const isHouseholdLockSql = (value: unknown): boolean => /\bFROM\s+households\b/.test(rawText(value));

const COND = { id: 'sentinel-condition' };
const PAGINATION = { offset: 0, limit: 10 };

const makeMember = (overrides: Partial<HouseholdMemberWithRelations> = {}): HouseholdMemberWithRelations =>
  ({
    id: 'member-1',
    userId: 'user-1',
    householdId: 'hh-1',
    showAllGames: true,
    // Null is the honest default for a fixture: these rows were not produced by
    // a consent path (#276), which is exactly what NULL means on the model.
    origin: null,
    addedById: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    user: {
      id: 'user-1',
      username: 'alice',
      profile: { avatarUrl: null, displayName: 'Alice' },
    },
    role: {
      id: 'hr-1',
      householdMemberId: 'member-1',
      roleId: 'role-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      role: { id: 'role-1', name: 'HouseholdMember' },
    },
    ...overrides,
  }) as HouseholdMemberWithRelations;

const makeOwner = (overrides: Partial<HouseholdMemberWithRelations> = {}): HouseholdMemberWithRelations =>
  makeMember({
    role: {
      id: 'hr-1',
      householdMemberId: 'member-1',
      roleId: 'role-owner',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      role: { id: 'role-owner', name: SystemRole.HouseholdOwner },
    },
    ...overrides,
  } as Partial<HouseholdMemberWithRelations>);

const dependentRecordNotFound = () =>
  new Prisma.PrismaClientKnownRequestError('no rows', {
    code: PrismaError.DependentRecordNotFound,
    clientVersion: 'test',
  });

describe('HouseholdMemberService', () => {
  let service: HouseholdMemberService;
  let db: MockDatabaseService;
  let abilityService: jest.Mocked<Pick<AbilityService, 'getCurrentResourceConditions' | 'getActingUserId'>>;
  let permissions: jest.Mocked<Pick<PermissionsService, 'invalidateUser' | 'invalidateUsers'>>;
  let events: jest.Mocked<Pick<EventEmitter2, 'emit'>>;
  let quotas: jest.Mocked<Pick<QuotaService, 'consume' | 'emitSoftOverages'>>;

  /**
   * Dispatches the two `householdMember.count` probes by shape rather than by
   * call order: the scoped probe carries the ability `AND`, the unscoped one
   * does not. Order-based mocking would silently pass if the probes were ever
   * reordered.
   */
  const stubCounts = ({ scoped, unscoped }: { scoped: number; unscoped: number }) => {
    db.householdMember.count.mockImplementation((args) => {
      const { where } = args as { where: Prisma.HouseholdMemberWhereInput };
      return Promise.resolve(where.AND ? scoped : unscoped) as Prisma.PrismaPromise<number>;
    });
  };

  /**
   * A `consume()` outcome. Defaults to the unconstrained shape `QuotaService`
   * returns when no cap applies, which is what every test that is not about
   * quota wants.
   */
  const quotaDecision = (overrides: Partial<QuotaCheckResult> = {}): QuotaCheckResult => ({
    allowed: true,
    scope: null,
    currentUsage: null,
    limit: null,
    softOverage: false,
    constraints: [],
    softOverages: [],
    ...overrides,
  });

  /**
   * Stubs both raw statements this service issues, keyed on which one is being
   * asked. `householdExists: false` is how a missing or soft-deleted household
   * is simulated for the member-creation seam.
   */
  const stubRawQueries = ({
    householdExists = true,
    owners = ['member-owner-a', 'member-owner-b'],
  }: { householdExists?: boolean; owners?: readonly string[] } = {}) => {
    db.$queryRaw.mockImplementation(
      (query: unknown) =>
        Promise.resolve(
          isHouseholdLockSql(query)
            ? householdExists
              ? [{ id: 'hh-1' }]
              : []
            : owners.map((household_member_id) => ({ household_member_id })),
        ) as Prisma.PrismaPromise<{ household_member_id: string }[] | { id: string }[]>,
    );
  };

  beforeEach(async () => {
    abilityService = {
      getCurrentResourceConditions: jest.fn().mockReturnValue([COND]),
      getActingUserId: jest.fn().mockReturnValue('actor-1'),
    };
    permissions = {
      invalidateUser: jest.fn().mockResolvedValue(undefined),
      invalidateUsers: jest.fn().mockResolvedValue(undefined),
    };
    events = { emit: jest.fn().mockReturnValue(true) };
    quotas = {
      consume: jest.fn().mockResolvedValue(quotaDecision()),
      emitSoftOverages: jest.fn(),
    };

    const ctx = await createTestingModuleWithDb({
      providers: [
        HouseholdMemberService,
        { provide: AbilityService, useValue: abilityService },
        { provide: PermissionsService, useValue: permissions },
        { provide: EventEmitter2, useValue: events },
        { provide: QuotaService, useValue: quotas },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(HouseholdMemberService);

    // Household exists by default; individual tests override the probe.
    db.household.count.mockResolvedValue(1);
    // Mutations run inside a transaction; unwrap onto the mock delegates.
    db.$transaction.mockImplementation((cb) => cb(db));
    // The owner lock is taken on EVERY membership mutation now, not only when the
    // departing member looks like an owner, so it needs a default — an unstubbed
    // `$queryRaw` resolves `undefined` and the lock's `.map` throws. Two owners
    // whose ids match nobody under test is the neutral default: no last-owner
    // refusal, no accidental already-owner match. Tests that care override it.
    //
    // Deliberately stubbed here rather than making `lockHouseholdOwnerRows`
    // tolerate a nullish result. `undefined` can only ever come from a mock — a
    // real `$queryRaw` returns an array — so defaulting it in production code
    // would convert a future harness gap into a silent "this household has no
    // owners", which is precisely the read the lock exists to make trustworthy.
    //
    // Dispatched by statement shape, not by call order.
    //
    // This file previously stubbed `$queryRaw` with a flat `mockResolvedValue`
    // of owner rows, which was correct while the owner lock was the only raw
    // statement in the service. `addMemberWithin` adds a second one (the
    // household share-lock), and under the flat stub that statement would have
    // received OWNER rows — a non-empty result, which `lockExistingHousehold`
    // reads as "household exists". Every soft-delete/404 test would then have
    // passed for the wrong reason, and a regression that dropped the guard
    // entirely would have gone unnoticed.
    //
    // Shape dispatch is the same discipline `stubCounts` above already applies
    // to the two `householdMember.count` probes, for the same reason: a stub
    // keyed on ordering silently starts lying the moment a call is added.
    stubRawQueries();
  });

  afterEach(() => jest.clearAllMocks());

  describe('getMembers', () => {
    it('scopes the list by read conditions on HouseholdMember and shapes with MEMBER_INCLUDE', async () => {
      db.householdMember.findMany.mockResolvedValue([makeMember()]);

      const result = await service.getMembers('hh-1', PAGINATION);

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.HouseholdMember,
        Action.read,
      );
      expect(db.householdMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ householdId: 'hh-1', AND: [COND] }),
          include: MEMBER_INCLUDE,
          orderBy: { createdAt: 'asc' },
        }),
      );
      expect(result).toHaveLength(1);
    });

    it('asserts the household exists (excluding soft-deleted) before querying', async () => {
      db.householdMember.findMany.mockResolvedValue([makeMember()]);

      await service.getMembers('hh-1', PAGINATION);

      expect(db.household.count).toHaveBeenCalledWith({ where: { id: 'hh-1', deletedAt: null } });
    });

    it('forwards pagination as skip/take with the 10-row default', async () => {
      db.householdMember.findMany.mockResolvedValue([makeMember()]);

      await service.getMembers('hh-1', { offset: 20, limit: 5 });
      expect(db.householdMember.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 5 }));

      await service.getMembers('hh-1', { offset: 0 });
      expect(db.householdMember.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 0, take: 10 }));
    });

    it('throws NotFound when the household does not exist', async () => {
      db.household.count.mockResolvedValue(0);

      await expect(service.getMembers('hh-missing', PAGINATION)).rejects.toThrow(NotFoundException);
      expect(db.householdMember.findMany).not.toHaveBeenCalled();
    });

    it('throws Forbidden when members exist but none are visible to the actor', async () => {
      db.householdMember.findMany.mockResolvedValue([]);
      stubCounts({ scoped: 0, unscoped: 4 });

      await expect(service.getMembers('hh-1', PAGINATION)).rejects.toThrow(ForbiddenException);

      expect(db.householdMember.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ householdId: 'hh-1', AND: [COND] }),
      });
      expect(db.householdMember.count).toHaveBeenCalledWith({ where: { householdId: 'hh-1' } });
    });

    it('returns an empty array — not Forbidden — for a household with no members at all', async () => {
      // Guards against depending on a "household always has >= 1 member"
      // invariant that nothing in the schema enforces (see #157).
      db.householdMember.findMany.mockResolvedValue([]);
      stubCounts({ scoped: 0, unscoped: 0 });

      await expect(service.getMembers('hh-1', PAGINATION)).resolves.toEqual([]);
    });

    it('returns an empty page when an authorized reader pages past the end', async () => {
      db.householdMember.findMany.mockResolvedValue([]);
      stubCounts({ scoped: 3, unscoped: 3 });

      await expect(service.getMembers('hh-1', { offset: 50, limit: 10 })).resolves.toEqual([]);
    });

    it('skips the unscoped probe when rows are visible to the actor', async () => {
      db.householdMember.findMany.mockResolvedValue([]);
      stubCounts({ scoped: 3, unscoped: 3 });

      await service.getMembers('hh-1', { offset: 50, limit: 10 });

      expect(db.householdMember.count).toHaveBeenCalledTimes(1);
    });

    it('skips both probes entirely when the page is non-empty', async () => {
      db.householdMember.findMany.mockResolvedValue([makeMember()]);

      await service.getMembers('hh-1', PAGINATION);

      expect(db.householdMember.count).not.toHaveBeenCalled();
    });
  });

  describe('getMember', () => {
    it('scopes the lookup by id + householdId + read conditions', async () => {
      db.householdMember.findUnique.mockResolvedValue(makeMember());

      const result = await service.getMember('hh-1', 'member-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.HouseholdMember,
        Action.read,
      );
      expect(db.householdMember.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'member-1', householdId: 'hh-1', AND: [COND] }),
          include: MEMBER_INCLUDE,
        }),
      );
      expect(result.id).toBe('member-1');
    });

    it('throws NotFound when the household does not exist', async () => {
      db.household.count.mockResolvedValue(0);

      await expect(service.getMember('hh-missing', 'member-1')).rejects.toThrow(NotFoundException);
      expect(db.householdMember.findUnique).not.toHaveBeenCalled();
    });

    it('throws Forbidden when the member exists but is not visible to the actor', async () => {
      db.householdMember.findUnique.mockResolvedValue(null);
      stubCounts({ scoped: 0, unscoped: 1 });

      await expect(service.getMember('hh-1', 'member-1')).rejects.toThrow(ForbiddenException);

      expect(db.householdMember.count).toHaveBeenCalledWith({ where: { id: 'member-1', householdId: 'hh-1' } });
    });

    it('throws NotFound when the member does not exist in the household', async () => {
      db.householdMember.findUnique.mockResolvedValue(null);
      stubCounts({ scoped: 0, unscoped: 0 });

      await expect(service.getMember('hh-1', 'member-missing')).rejects.toThrow(NotFoundException);
    });

    it('uses the same scoped-then-unscoped probe order as getMembers', async () => {
      db.householdMember.findUnique.mockResolvedValue(null);
      stubCounts({ scoped: 0, unscoped: 1 });

      await expect(service.getMember('hh-1', 'member-1')).rejects.toThrow(ForbiddenException);

      const [first, second] = db.householdMember.count.mock.calls;
      expect(first[0]).toEqual(expect.objectContaining({ where: expect.objectContaining({ AND: [COND] }) }));
      expect(second[0]).toEqual({ where: { id: 'member-1', householdId: 'hh-1' } });
    });
  });

  describe('updateMemberRole', () => {
    const DTO = { role: SystemRole.HouseholdAdmin } as const;

    beforeEach(() => {
      db.role.findUnique.mockResolvedValue({ id: 'role-admin' } as never);
    });

    it('scopes the target by manage conditions, upserts the 1:1 role, and evicts the target cache', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeMember());
      db.householdMember.findUniqueOrThrow.mockResolvedValue(
        makeMember({
          role: {
            id: 'hr-1',
            householdMemberId: 'member-1',
            roleId: 'role-admin',
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-01-02T00:00:00Z'),
            role: { id: 'role-admin', name: SystemRole.HouseholdAdmin },
          },
        } as Partial<HouseholdMemberWithRelations>),
      );

      const result = await service.updateMemberRole('hh-1', 'member-1', DTO);

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.HouseholdMember,
        Action.manage,
      );
      expect(db.householdMember.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'member-1', householdId: 'hh-1', AND: [COND] }),
          include: MEMBER_INCLUDE,
        }),
      );
      // The role is resolved explicitly, then connected by FK: a nested
      // `connect: { name }` would raise the same P2025 as a vanished member row.
      expect(db.role.findUnique).toHaveBeenCalledWith({
        where: { name: SystemRole.HouseholdAdmin },
        select: { id: true },
      });
      expect(db.householdRole.upsert).toHaveBeenCalledWith({
        where: { householdMemberId: 'member-1' },
        create: { householdMemberId: 'member-1', roleId: 'role-admin' },
        update: { roleId: 'role-admin' },
      });
      // The re-read returns the post-write shape; the target's graph is evicted.
      expect(db.householdMember.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 'member-1' },
        include: MEMBER_INCLUDE,
      });
      expect(permissions.invalidateUser).toHaveBeenCalledWith('user-1');
      expect(result.role?.role.name).toBe(SystemRole.HouseholdAdmin);
    });

    it('upserts (create arm) for a member that has no role row yet', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeMember({ role: null }));
      db.householdMember.findUniqueOrThrow.mockResolvedValue(makeMember());
      db.role.findUnique.mockResolvedValue({ id: 'role-guest' } as never);

      await service.updateMemberRole('hh-1', 'member-1', { role: SystemRole.HouseholdGuest });

      expect(db.householdRole.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: { householdMemberId: 'member-1', roleId: 'role-guest' } }),
      );
    });

    it('fails loud (500) when the target role is not provisioned, rather than reporting 403', async () => {
      // Seed drift: an assignable SystemRole with no `roles` row. Connecting by
      // name would surface this as a P2025 → 403, describing a server
      // misconfiguration as the caller's lack of permission.
      db.householdMember.findFirst.mockResolvedValue(makeMember());
      db.role.findUnique.mockResolvedValue(null);

      await expect(service.updateMemberRole('hh-1', 'member-1', DTO)).rejects.toThrow(InternalServerErrorException);

      expect(db.householdRole.upsert).not.toHaveBeenCalled();
      expect(permissions.invalidateUser).not.toHaveBeenCalled();
    });

    it('rejects changing your own role (400) without writing or invalidating', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeMember({ userId: 'actor-1' }));

      await expect(service.updateMemberRole('hh-1', 'member-1', DTO)).rejects.toThrow(BadRequestException);

      expect(db.householdRole.upsert).not.toHaveBeenCalled();
      expect(permissions.invalidateUser).not.toHaveBeenCalled();
    });

    it('rejects changing an owner (400) — owner transitions belong to transfer-ownership (#158)', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeOwner());

      await expect(service.updateMemberRole('hh-1', 'member-1', DTO)).rejects.toThrow(BadRequestException);

      expect(db.householdRole.upsert).not.toHaveBeenCalled();
      expect(permissions.invalidateUser).not.toHaveBeenCalled();
    });

    it('throws NotFound when the household does not exist', async () => {
      db.household.count.mockResolvedValue(0);

      await expect(service.updateMemberRole('hh-missing', 'member-1', DTO)).rejects.toThrow(NotFoundException);
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('throws Forbidden — naming the UPDATE denial, not view — when the actor may not manage the member', async () => {
      db.householdMember.findFirst.mockResolvedValue(null);
      db.householdMember.count.mockResolvedValue(1);

      await expect(service.updateMemberRole('hh-1', 'member-1', DTO)).rejects.toMatchObject({
        status: Http.Forbidden,
        response: expect.objectContaining({ key: 'common.forbidden.update' }),
      });
      expect(db.householdRole.upsert).not.toHaveBeenCalled();
    });

    it('throws NotFound when the member does not exist in the household', async () => {
      db.householdMember.findFirst.mockResolvedValue(null);
      db.householdMember.count.mockResolvedValue(0);

      await expect(service.updateMemberRole('hh-1', 'member-missing', DTO)).rejects.toThrow(NotFoundException);
    });

    it('maps a write-time scoped miss (P2025) to Forbidden without invalidating', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeMember());
      db.householdRole.upsert.mockRejectedValue(dependentRecordNotFound());

      await expect(service.updateMemberRole('hh-1', 'member-1', DTO)).rejects.toThrow(ForbiddenException);
      expect(permissions.invalidateUser).not.toHaveBeenCalled();
    });
  });

  describe('removeMember', () => {
    beforeEach(() => {
      db.excludedGame.deleteMany.mockResolvedValue({ count: 0 } as never);
      db.householdRole.deleteMany.mockResolvedValue({ count: 1 } as never);
      db.householdMember.delete.mockResolvedValue(makeMember() as never);
    });

    it('removes a non-owner member under the manage scope, cleaning dependents in order', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeMember());

      const result = await service.removeMember('hh-1', 'member-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.HouseholdMember,
        Action.manage,
      );
      // The lock is now taken unconditionally and the last-owner refusal is
      // decided from the LOCKED set, not from the pre-lock read of `member.role`.
      // #157 skipped the lock for non-owner departures, which was sound only
      // while nothing could promote a member to owner concurrently — #158's
      // transfer path is exactly that, so a member promoted between the read and
      // the commit would have been deleted with no check at all.
      expect(db.$queryRaw).toHaveBeenCalledTimes(1);
      // Not among the locked owners, so the refusal does not apply.
      expect(db.householdMember.delete).toHaveBeenCalled();

      expect(db.excludedGame.deleteMany).toHaveBeenCalledWith({ where: { householdMemberId: 'member-1' } });
      expect(db.householdRole.deleteMany).toHaveBeenCalledWith({ where: { householdMemberId: 'member-1' } });
      expect(db.householdMember.delete).toHaveBeenCalledWith({
        where: expect.objectContaining({ id: 'member-1', householdId: 'hh-1', AND: [COND] }),
      });

      // No cascades exist in the schema — dependents strictly before the member row.
      const excludedOrder = db.excludedGame.deleteMany.mock.invocationCallOrder[0];
      const roleOrder = db.householdRole.deleteMany.mock.invocationCallOrder[0];
      const memberOrder = db.householdMember.delete.mock.invocationCallOrder[0];
      expect(excludedOrder).toBeLessThan(roleOrder);
      expect(roleOrder).toBeLessThan(memberOrder);

      expect(permissions.invalidateUser).toHaveBeenCalledWith('user-1');
      expect(result.id).toBe('member-1');
    });

    it('locks the owner rows and allows removing an owner when another owner remains', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeOwner());
      db.$queryRaw.mockResolvedValue([{ household_member_id: 'member-1' }, { household_member_id: 'member-2' }]);

      await service.removeMember('hh-1', 'member-1');

      expect(db.$queryRaw).toHaveBeenCalledTimes(1);
      expect(db.householdMember.delete).toHaveBeenCalled();
      expect(permissions.invalidateUser).toHaveBeenCalledWith('user-1');
    });

    it('rejects removing the sole owner (400) without deleting or invalidating', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeOwner());
      db.$queryRaw.mockResolvedValue([{ household_member_id: 'member-1' }]);

      await expect(service.removeMember('hh-1', 'member-1')).rejects.toThrow(BadRequestException);

      expect(db.excludedGame.deleteMany).not.toHaveBeenCalled();
      expect(db.householdRole.deleteMany).not.toHaveBeenCalled();
      expect(db.householdMember.delete).not.toHaveBeenCalled();
      expect(permissions.invalidateUser).not.toHaveBeenCalled();
    });

    it('throws NotFound when the household does not exist', async () => {
      db.household.count.mockResolvedValue(0);

      await expect(service.removeMember('hh-missing', 'member-1')).rejects.toThrow(NotFoundException);
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('throws Forbidden — naming the DELETE denial, not view — when the actor may not manage the member', async () => {
      db.householdMember.findFirst.mockResolvedValue(null);
      db.householdMember.count.mockResolvedValue(1);

      await expect(service.removeMember('hh-1', 'member-1')).rejects.toMatchObject({
        status: Http.Forbidden,
        response: expect.objectContaining({ key: 'common.forbidden.delete' }),
      });
      expect(db.householdMember.delete).not.toHaveBeenCalled();
    });

    it('throws NotFound when the member does not exist in the household', async () => {
      db.householdMember.findFirst.mockResolvedValue(null);
      db.householdMember.count.mockResolvedValue(0);

      await expect(service.removeMember('hh-1', 'member-missing')).rejects.toThrow(NotFoundException);
    });

    it('maps a write-time scoped miss (P2025) to Forbidden without invalidating', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeMember());
      db.householdMember.delete.mockRejectedValue(dependentRecordNotFound());

      await expect(service.removeMember('hh-1', 'member-1')).rejects.toThrow(ForbiddenException);
      expect(permissions.invalidateUser).not.toHaveBeenCalled();
    });

    describe('log levels', () => {
      let errorSpy: jest.SpyInstance;

      beforeEach(() => {
        errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      });

      afterEach(() => jest.restoreAllMocks());

      it('does not log business-rule rejections at error level', async () => {
        // A client-driven 400 on a normal endpoint must not be indistinguishable
        // from a defect in log-based alerting.
        db.householdMember.findFirst.mockResolvedValue(makeOwner());
        db.$queryRaw.mockResolvedValue([{ household_member_id: 'member-1' }]);

        await expect(service.removeMember('hh-1', 'member-1')).rejects.toThrow(BadRequestException);

        expect(errorSpy).not.toHaveBeenCalled();
      });

      it('does not log an expected scoped-write miss (P2025) at error level', async () => {
        db.householdMember.findFirst.mockResolvedValue(makeMember());
        db.householdMember.delete.mockRejectedValue(dependentRecordNotFound());

        await expect(service.removeMember('hh-1', 'member-1')).rejects.toThrow(ForbiddenException);

        expect(errorSpy).not.toHaveBeenCalled();
      });

      it('logs an unexpected failure at error level and rethrows it unchanged', async () => {
        const boom = new Error('connection reset');
        db.householdMember.findFirst.mockResolvedValue(makeMember());
        db.householdMember.delete.mockRejectedValue(boom);

        await expect(service.removeMember('hh-1', 'member-1')).rejects.toBe(boom);

        expect(errorSpy).toHaveBeenCalled();
      });
    });
  });

  describe('leaveHousehold', () => {
    beforeEach(() => {
      db.excludedGame.deleteMany.mockResolvedValue({ count: 0 } as never);
      db.householdRole.deleteMany.mockResolvedValue({ count: 1 } as never);
      db.householdMember.delete.mockResolvedValue(makeMember() as never);
    });

    it('scopes by delete conditions AND an explicit userId pin (manage implies delete for admins)', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeMember({ userId: 'actor-1' }));

      await service.leaveHousehold('hh-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.HouseholdMember,
        Action.delete,
      );
      // The pin is what makes "me" mean me: an Owner/Admin's delete conditions
      // (via CASL manage) cover every member of their household.
      expect(db.householdMember.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ householdId: 'hh-1', userId: 'actor-1', AND: [COND] }),
        }),
      );
      expect(db.householdMember.delete).toHaveBeenCalledWith({
        where: expect.objectContaining({ householdId: 'hh-1', userId: 'actor-1', AND: [COND], id: 'member-1' }),
      });
      expect(permissions.invalidateUser).toHaveBeenCalledWith('actor-1');
    });

    it('rejects the sole owner leaving (400) — transfer ownership first', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeOwner({ userId: 'actor-1' }));
      db.$queryRaw.mockResolvedValue([{ household_member_id: 'member-1' }]);

      await expect(service.leaveHousehold('hh-1')).rejects.toThrow(BadRequestException);

      expect(db.householdMember.delete).not.toHaveBeenCalled();
      expect(permissions.invalidateUser).not.toHaveBeenCalled();
    });

    it('allows an owner to leave when another owner remains', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeOwner({ userId: 'actor-1' }));
      db.$queryRaw.mockResolvedValue([{ household_member_id: 'member-1' }, { household_member_id: 'member-2' }]);

      await service.leaveHousehold('hh-1');

      expect(db.householdMember.delete).toHaveBeenCalled();
      expect(permissions.invalidateUser).toHaveBeenCalledWith('actor-1');
    });

    it('throws NotFound when the acting user is not a member of the household', async () => {
      db.householdMember.findFirst.mockResolvedValue(null);
      db.householdMember.count.mockResolvedValue(0);

      await expect(service.leaveHousehold('hh-1')).rejects.toThrow(NotFoundException);
      expect(db.householdMember.delete).not.toHaveBeenCalled();
    });

    it('throws Forbidden naming the DELETE denial when the row exists but is not deletable by the actor', async () => {
      db.householdMember.findFirst.mockResolvedValue(null);
      db.householdMember.count.mockResolvedValue(1);

      await expect(service.leaveHousehold('hh-1')).rejects.toMatchObject({
        status: Http.Forbidden,
        response: expect.objectContaining({ key: 'common.forbidden.delete' }),
      });
    });

    it('throws NotFound when the household does not exist', async () => {
      db.household.count.mockResolvedValue(0);

      await expect(service.leaveHousehold('hh-missing')).rejects.toThrow(NotFoundException);
      expect(db.$transaction).not.toHaveBeenCalled();
    });
  });
  describe('transferOwnership', () => {
    const ACTOR = () => makeOwner({ id: 'member-actor', userId: 'actor-1' });
    const TARGET = () => makeMember({ id: 'member-2', userId: 'user-2' });

    /**
     * Dispatches the role lookups by requested name rather than by call order —
     * the service resolves owner-then-admin today, and an order-based stub would
     * pass a swap that assigns the wrong role to each party.
     */
    const stubRoles = (ids: Partial<Record<SystemRole, string>>) => {
      db.role.findUnique.mockImplementation((args) => {
        const { where } = args as { where: { name: SystemRole } };
        const id = ids[where.name];

        return Promise.resolve(id ? { id } : null) as never;
      });
    };

    /** Actor row resolves first, then the target — both via findScopedMemberOrThrow. */
    const stubMembers = (actor: HouseholdMemberWithRelations | null, target?: HouseholdMemberWithRelations | null) => {
      db.householdMember.findFirst.mockResolvedValueOnce(actor as never);
      if (target !== undefined) {
        db.householdMember.findFirst.mockResolvedValueOnce(target as never);
      }
    };

    /**
     * The preflight counts the actor's membership (`userId`); the hidden/missing
     * probes count by member id. Dispatched on shape so neither depends on the
     * order the service happens to issue them in.
     */
    const stubTransferCounts = ({ actorIsMember, targetExists }: { actorIsMember: boolean; targetExists: boolean }) => {
      db.householdMember.count.mockImplementation((args) => {
        const { where } = args as { where: { userId?: string } };

        return Promise.resolve((where.userId ? actorIsMember : targetExists) ? 1 : 0) as never;
      });
    };

    beforeEach(() => {
      stubTransferCounts({ actorIsMember: true, targetExists: true });
      stubRoles({ [SystemRole.HouseholdOwner]: 'role-owner', [SystemRole.HouseholdAdmin]: 'role-admin' });
      db.$queryRaw.mockResolvedValue([{ household_member_id: 'member-actor' }]);
      db.householdMember.findUniqueOrThrow
        .mockResolvedValueOnce(makeOwner({ id: 'member-2', userId: 'user-2' }) as never)
        .mockResolvedValueOnce(
          makeMember({
            id: 'member-actor',
            userId: 'actor-1',
            role: {
              id: 'hr-actor',
              householdMemberId: 'member-actor',
              roleId: 'role-admin',
              createdAt: new Date('2026-01-01T00:00:00Z'),
              updatedAt: new Date('2026-01-02T00:00:00Z'),
              role: { id: 'role-admin', name: SystemRole.HouseholdAdmin },
            },
          } as Partial<HouseholdMemberWithRelations>) as never,
        );
    });

    it('promotes the target and demotes the acting owner in one transaction', async () => {
      stubMembers(ACTOR(), TARGET());

      const result = await service.transferOwnership('hh-1', 'member-2');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.HouseholdMember,
        Action.manage,
      );
      expect(db.householdRole.upsert).toHaveBeenCalledWith({
        where: { householdMemberId: 'member-2' },
        create: { householdMemberId: 'member-2', roleId: 'role-owner' },
        update: { roleId: 'role-owner' },
      });
      expect(db.householdRole.upsert).toHaveBeenCalledWith({
        where: { householdMemberId: 'member-actor' },
        create: { householdMemberId: 'member-actor', roleId: 'role-admin' },
        update: { roleId: 'role-admin' },
      });
      expect(result.owner.id).toBe('member-2');
      expect(result.previousOwner.id).toBe('member-actor');
    });

    it('resolves both roles by name so seed drift cannot masquerade as a permission failure', async () => {
      stubMembers(ACTOR(), TARGET());

      await service.transferOwnership('hh-1', 'member-2');

      expect(db.role.findUnique).toHaveBeenCalledWith({
        where: { name: SystemRole.HouseholdOwner },
        select: { id: true },
      });
      expect(db.role.findUnique).toHaveBeenCalledWith({
        where: { name: SystemRole.HouseholdAdmin },
        select: { id: true },
      });
    });

    it('does NOT carry ability conditions into the upsert where clauses', async () => {
      // An upsert whose `where` matches nothing INSERTS. Scoping it the way the
      // scoped deletes are scoped would turn an authorization miss into a
      // unique-constraint error rather than the P2025 -> 403 those paths rely on.
      stubMembers(ACTOR(), TARGET());

      await service.transferOwnership('hh-1', 'member-2');

      for (const [args] of db.householdRole.upsert.mock.calls) {
        expect(args?.where).not.toHaveProperty('AND');
      }
    });

    it('creates the role row for a target that has none yet', async () => {
      stubMembers(ACTOR(), makeMember({ id: 'member-2', userId: 'user-2', role: null }));

      await service.transferOwnership('hh-1', 'member-2');

      expect(db.householdRole.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: { householdMemberId: 'member-2', roleId: 'role-owner' } }),
      );
    });

    it('evicts both parties in one bulk call', async () => {
      stubMembers(ACTOR(), TARGET());

      await service.transferOwnership('hh-1', 'member-2');

      expect(permissions.invalidateUsers).toHaveBeenCalledWith(['actor-1', 'user-2']);
      expect(permissions.invalidateUser).not.toHaveBeenCalled();
    });

    it('takes the owner lock before issuing either write', async () => {
      stubMembers(ACTOR(), TARGET());

      await service.transferOwnership('hh-1', 'member-2');

      expect(db.$queryRaw).toHaveBeenCalledTimes(1);
      // Locked before either write, or it guards nothing.
      const lockOrder = db.$queryRaw.mock.invocationCallOrder[0];
      const firstUpsert = db.householdRole.upsert.mock.invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(firstUpsert);
    });

    it('refuses (403) an owner demoted concurrently, whose own row still says owner', async () => {
      // Same guard as above, reached from the state that actually matters: the
      // actor's row reads HouseholdOwner, and the locked set disagrees because a
      // concurrent transfer demoted them. Deciding from `actor.role` would let
      // this through and produce two owners-turned-admins and no owner.
      stubMembers(ACTOR(), TARGET());
      db.$queryRaw.mockResolvedValue([{ household_member_id: 'member-9' }]);

      await expect(service.transferOwnership('hh-1', 'member-2')).rejects.toMatchObject({
        status: Http.Forbidden,
        response: expect.objectContaining({ key: 'common.forbidden.update' }),
      });
      expect(db.householdRole.upsert).not.toHaveBeenCalled();
      expect(permissions.invalidateUsers).not.toHaveBeenCalled();
    });

    it('reads both members under the lock, so no pre-lock/post-lock skew exists', async () => {
      // The earlier design read first and re-checked after locking. Locking
      // first removes the window instead of double-checking it.
      stubMembers(ACTOR(), TARGET());

      await service.transferOwnership('hh-1', 'member-2');

      const lockOrder = db.$queryRaw.mock.invocationCallOrder[0];
      const firstRead = db.householdMember.findFirst.mock.invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(firstRead);
    });

    it('refuses (403) an actor absent from the locked owner set, before reading the target', async () => {
      // Authorization strictly before validation: a 400 naming the target would
      // answer "is member X already the owner?" for someone about to get a 403.
      //
      // Note what expresses "not an owner" here. The guard reads the LOCKED set,
      // never `actor.role` — so the member row's role field is irrelevant and
      // stubbing it non-owner would prove nothing. The locked set is the only
      // authority, which is the whole point of taking the lock first.
      db.$queryRaw.mockResolvedValue([{ household_member_id: 'member-someone-else' }]);
      stubMembers(makeMember({ id: 'member-actor', userId: 'actor-1' }));

      await expect(service.transferOwnership('hh-1', 'member-2')).rejects.toMatchObject({
        status: Http.Forbidden,
        response: expect.objectContaining({ key: 'common.forbidden.update' }),
      });
      // Only the actor was read; the target was never touched.
      expect(db.householdMember.findFirst).toHaveBeenCalledTimes(1);
      expect(db.householdRole.upsert).not.toHaveBeenCalled();
    });

    it('refuses a non-member without opening a transaction or taking the lock', async () => {
      // The controller gate asserts the actor owns SOME household, not this one,
      // so an owner of another household reaches the service. Without the
      // preflight they would lock this household's owner rows before being
      // refused, giving any authenticated owner a contention lever against any
      // household id they can name.
      stubTransferCounts({ actorIsMember: false, targetExists: true });

      await expect(service.transferOwnership('hh-other', 'member-2')).rejects.toMatchObject({
        status: Http.NotFound,
        response: expect.objectContaining({ key: 'errors.household.not_a_member' }),
      });
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.$queryRaw).not.toHaveBeenCalled();
    });

    it('refuses (400) transferring to yourself', async () => {
      const actor = ACTOR();
      stubMembers(actor, actor);

      await expect(service.transferOwnership('hh-1', 'member-actor')).rejects.toThrow(BadRequestException);
      expect(db.householdRole.upsert).not.toHaveBeenCalled();
    });

    it('refuses (400) a target that already holds owner, per the locked set', async () => {
      db.$queryRaw.mockResolvedValue([{ household_member_id: 'member-actor' }, { household_member_id: 'member-2' }]);
      stubMembers(ACTOR(), makeOwner({ id: 'member-2', userId: 'user-2' }));

      await expect(service.transferOwnership('hh-1', 'member-2')).rejects.toThrow(BadRequestException);
      expect(db.householdRole.upsert).not.toHaveBeenCalled();
    });

    it('fails loud (500) when either household role is unprovisioned', async () => {
      stubMembers(ACTOR(), TARGET());
      stubRoles({ [SystemRole.HouseholdOwner]: 'role-owner' });

      await expect(service.transferOwnership('hh-1', 'member-2')).rejects.toThrow(InternalServerErrorException);
      // Resolved outside the transaction, so seed drift never opens one or takes
      // the owner lock.
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(permissions.invalidateUsers).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('throws NotFound when the household does not exist', async () => {
      db.household.count.mockResolvedValue(0);

      await expect(service.transferOwnership('hh-missing', 'member-2')).rejects.toThrow(NotFoundException);
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('throws NotFound naming the actor when the acting user is not a member', async () => {
      stubTransferCounts({ actorIsMember: false, targetExists: false });
      stubMembers(null);

      await expect(service.transferOwnership('hh-1', 'member-2')).rejects.toMatchObject({
        status: Http.NotFound,
        response: expect.objectContaining({ key: 'errors.household.not_a_member' }),
      });
    });

    it('throws NotFound naming the target when the target member does not exist', async () => {
      stubTransferCounts({ actorIsMember: true, targetExists: false });
      stubMembers(ACTOR(), null);

      await expect(service.transferOwnership('hh-1', 'member-missing')).rejects.toMatchObject({
        status: Http.NotFound,
        response: expect.objectContaining({ key: 'errors.household.member_not_found' }),
      });
    });

    it('reports the UPDATE denial, not view, for a target hidden from the actor', async () => {
      stubTransferCounts({ actorIsMember: true, targetExists: true });
      stubMembers(ACTOR(), null);

      await expect(service.transferOwnership('hh-1', 'member-2')).rejects.toMatchObject({
        status: Http.Forbidden,
        response: expect.objectContaining({ key: 'common.forbidden.update' }),
      });
    });

    it('maps a write-time P2025 to Forbidden without invalidating or emitting', async () => {
      stubMembers(ACTOR(), TARGET());
      db.householdRole.upsert.mockRejectedValue(dependentRecordNotFound());

      await expect(service.transferOwnership('hh-1', 'member-2')).rejects.toThrow(ForbiddenException);
      expect(permissions.invalidateUsers).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    describe('emissions', () => {
      it('emits the audited mutation event describing the household, not a role row', async () => {
        stubMembers(ACTOR(), TARGET());

        await service.transferOwnership('hh-1', 'member-2');

        expect(events.emit).toHaveBeenCalledWith(
          HouseholdEvents.OwnershipTransferred,
          expect.objectContaining({
            subject: ResourceType.Household,
            subjectId: 'hh-1',
            action: 'update',
            before: { householdId: 'hh-1', ownerMemberId: 'member-actor', ownerUserId: 'actor-1' },
            after: { householdId: 'hh-1', ownerMemberId: 'member-2', ownerUserId: 'user-2' },
          }),
        );
      });

      it('emits a webhook envelope whose subjectId resolves against the descriptor subject', async () => {
        // The dispatcher checks visibility of `subjectId` AS the descriptor's
        // subject (Household). A role-row id here would resolve to no row and the
        // event would be registered but never delivered.
        stubMembers(ACTOR(), TARGET());

        await service.transferOwnership('hh-1', 'member-2');

        expect(events.emit).toHaveBeenCalledWith(
          WebhookEventType.HouseholdOwnershipTransferred,
          expect.objectContaining({ subjectId: 'hh-1', householdId: 'hh-1' }),
        );
      });

      it('carries ids only in the webhook body — no usernames, profiles, or emails', async () => {
        stubMembers(ACTOR(), TARGET());

        await service.transferOwnership('hh-1', 'member-2');

        const envelope = events.emit.mock.calls.find(
          ([name]) => name === WebhookEventType.HouseholdOwnershipTransferred,
        )?.[1] as { data: Record<string, unknown> };

        expect(envelope.data).toEqual({
          householdId: 'hh-1',
          previousOwnerMemberId: 'member-actor',
          previousOwnerUserId: 'actor-1',
          newOwnerMemberId: 'member-2',
          newOwnerUserId: 'user-2',
        });
      });

      it('does not fail the request when a listener throws after the commit', async () => {
        // EventEmitter2 is configured without `ignoreErrors`, so a synchronous
        // listener that throws propagates out of emit(). The transfer is already
        // committed at that point — reporting 500 would send the client to retry
        // into a 400 "already an owner".
        stubMembers(ACTOR(), TARGET());
        const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        events.emit.mockImplementation(() => {
          throw new Error('audit listener exploded');
        });

        const result = await service.transferOwnership('hh-1', 'member-2');

        expect(result.owner.id).toBe('member-2');
        expect(logged).toHaveBeenCalled();
        logged.mockRestore();
      });

      it('omits occurrenceId rather than reusing an id that is stable across transfers', async () => {
        // householdId and either role-row id are stable across DIFFERENT
        // transfers, so using one as the dedup key would drop the second
        // legitimate transfer's delivery. No key means no dedup, which is the
        // envelope's documented fallback.
        stubMembers(ACTOR(), TARGET());

        await service.transferOwnership('hh-1', 'member-2');

        const envelope = events.emit.mock.calls.find(
          ([name]) => name === WebhookEventType.HouseholdOwnershipTransferred,
        )?.[1] as { occurrenceId?: string };

        expect(envelope.occurrenceId).toBeUndefined();
      });

      it('emits only after the transaction commits', async () => {
        // Deliberately NOT an `invocationCallOrder` comparison. The db delegates
        // come from `createMockDatabaseService`, which builds them with a
        // directly-imported `jest-mock`; `events.emit` here is the global
        // `jest.fn()` from the test environment. Those are two separate
        // ModuleMocker instances with independent invocation counters, so their
        // order values are not comparable — a comparison between them reads as a
        // real ordering failure while proving nothing either way. Order is only
        // safe to compare among mocks from the SAME source (see the owner-lock
        // test, which compares two db delegates).
        //
        // Probing from inside the transaction tests the property directly: an
        // emission describing a transfer that later rolled back is worse than a
        // missing one, so nothing may fire while the transaction is still open.
        stubMembers(ACTOR(), TARGET());
        let emitsDuringTransaction = -1;
        db.$transaction.mockImplementation(async (cb) => {
          const committed = await cb(db);
          emitsDuringTransaction = events.emit.mock.calls.length;

          return committed;
        });

        await service.transferOwnership('hh-1', 'member-2');

        expect(emitsDuringTransaction).toBe(0);
        // Both subsystems fed from the one call site: audit + webhook.
        expect(events.emit).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('ownerless-household race (review finding 1)', () => {
    it('refuses to delete a member the locked set reports as sole owner, whatever the read said', async () => {
      // The read returns a plain member — the state before a concurrent
      // transferOwnership committed. The lock reports that same member as the
      // household's only owner. Deciding from `member.role` here deletes the
      // last owner and leaves the household unadministrable, with no error.
      db.householdMember.findFirst.mockResolvedValue(makeMember({ id: 'member-1' }));
      db.$queryRaw.mockResolvedValue([{ household_member_id: 'member-1' }]);

      await expect(service.removeMember('hh-1', 'member-1')).rejects.toMatchObject({
        status: Http.BadRequest,
        response: expect.objectContaining({ key: 'errors.household.last_owner' }),
      });
      expect(db.householdMember.delete).not.toHaveBeenCalled();
      expect(permissions.invalidateUser).not.toHaveBeenCalled();
    });

    it('does not take a household-wide lock for a request that 404s', async () => {
      // Reading first is safe here — the decision uses only the immutable
      // `member.id` plus the locked set — and it keeps missing-member requests
      // from locking every owner row in the household.
      db.householdMember.findFirst.mockResolvedValue(null);
      db.householdMember.count.mockResolvedValue(0);

      await expect(service.removeMember('hh-1', 'member-missing')).rejects.toThrow(NotFoundException);
      expect(db.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('addMemberWithin', () => {
    /**
     * The seam takes a `Prisma.TransactionClient` because its guarantees are row
     * locks, which only hold for the life of a transaction. The mock is
     * structurally a subset of that client, so one documented widening lives
     * here rather than an `any` at every call site.
     */
    const asTx = (client: MockDatabaseService): Prisma.TransactionClient =>
      client as unknown as Prisma.TransactionClient;

    const PARAMS = {
      householdId: 'hh-1',
      userId: 'user-2',
      origin: HouseholdMembershipOrigin.InviteAccepted,
      addedById: 'user-inviter',
    } as const;

    /** No existing membership, role row present. The happy-path preconditions. */
    const stubAdmissible = (created: HouseholdMemberWithRelations = makeMember({ id: 'member-new' })) => {
      db.householdMember.findUnique.mockResolvedValue(null);
      db.role.findUnique.mockResolvedValue({ id: 'role-member' } as never);
      db.householdMember.create.mockResolvedValue(created as never);
    };

    const uniqueConstraintError = (target: string | string[] = HOUSEHOLD_MEMBER_UNIQUE_CONSTRAINT) =>
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: PrismaError.UniqueConstraintViolation,
        clientVersion: 'test',
        meta: { target },
      });

    it('inserts the member and its role in the caller transaction, shaped by MEMBER_INCLUDE', async () => {
      const created = makeMember({ id: 'member-new', userId: 'user-2' });
      stubAdmissible(created);

      const result = await service.addMemberWithin(asTx(db), PARAMS);

      expect(db.householdMember.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            householdId: 'hh-1',
            userId: 'user-2',
            role: { create: { roleId: 'role-member' } },
          }),
          include: MEMBER_INCLUDE,
        }),
      );
      expect(result.member).toBe(created);
    });

    it('defaults the role to HouseholdMember', async () => {
      stubAdmissible();

      await service.addMemberWithin(asTx(db), PARAMS);

      expect(db.role.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { name: SystemRole.HouseholdMember } }),
      );
    });

    it.each([SystemRole.HouseholdAdmin, SystemRole.HouseholdGuest, SystemRole.HouseholdMember] as const)(
      'accepts the assignable role %s',
      async (role: AssignableHouseholdRole) => {
        stubAdmissible();

        await service.addMemberWithin(asTx(db), { ...PARAMS, role });

        expect(db.role.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { name: role } }));
        expect(db.householdMember.create).toHaveBeenCalled();
      },
    );

    // Rejected BEFORE any write is issued. Rejecting after the insert would
    // leave the refusal dependent on a rollback the caller controls, and an
    // owner admitted here would bypass transfer-ownership's locking (#158).
    it.each([SystemRole.HouseholdOwner, SystemRole.Admin, SystemRole.EventHost] as const)(
      'rejects the non-assignable role %s without writing',
      async (role: SystemRole) => {
        stubAdmissible();

        await expect(
          // Cast is the point of the test: a caller resolving a role from an
          // `Invite.roleId` holds a plain `SystemRole`, and the runtime guard —
          // not just the parameter type — has to refuse it.
          service.addMemberWithin(asTx(db), { ...PARAMS, role: role as AssignableHouseholdRole }),
        ).rejects.toThrow(BadRequestException);

        expect(db.householdMember.create).not.toHaveBeenCalled();
        expect(db.householdRole.create).not.toHaveBeenCalled();
        // `$queryRaw` alone only proves the household ROW lock was skipped. The
        // advisory lock lives inside the mocked `consume`, so without this a
        // refactor that moved quota consumption ahead of the role guard would
        // still pass while taking a lock for a request that cannot succeed.
        expect(db.$queryRaw).not.toHaveBeenCalled();
        expect(quotas.consume).not.toHaveBeenCalled();
      },
    );

    it('throws NotFound when the household is missing or soft-deleted, without writing', async () => {
      stubAdmissible();
      stubRawQueries({ householdExists: false });

      await expect(service.addMemberWithin(asTx(db), PARAMS)).rejects.toThrow(NotFoundException);
      expect(db.householdMember.create).not.toHaveBeenCalled();
    });

    it('takes the household share lock on the caller transaction, not the base client', async () => {
      stubAdmissible();
      const tx = { ...db, $queryRaw: jest.fn().mockResolvedValue([{ id: 'hh-1' }]) } as unknown as MockDatabaseService;

      await service.addMemberWithin(asTx(tx), PARAMS);

      expect(tx.$queryRaw).toHaveBeenCalled();
      // A lock taken on the base client would serialize nothing: the guarantee
      // only holds for the life of the caller's transaction.
      expect(db.$queryRaw).not.toHaveBeenCalled();
    });

    // The seam owns the soft-delete guard outright, and this assertion is the
    // thing that keeps it that way.
    //
    // Adding `assertHouseholdExists` alongside the lock would NOT be harmless
    // belt-and-braces. It is an unlocked `count` on the base client, so it
    // answers from outside the caller's transaction and its result is stale the
    // instant it returns — the precise read/insert window `lockExistingHousehold`
    // exists to close. Two guards where one is unsound reads as more careful
    // while making the unsound one look load-bearing, and the next person to
    // touch this has to re-derive which of the two actually holds. The lock
    // already covers both outcomes the probe would (absent, soft-deleted), so
    // the probe can only add a redundant round trip and a false sense of rigor.
    it('does not use the unlocked household existence probe', async () => {
      stubAdmissible();

      await service.addMemberWithin(asTx(db), PARAMS);

      expect(db.household.count).not.toHaveBeenCalled();
    });

    it('persists the supplied origin and addedById', async () => {
      stubAdmissible();

      await service.addMemberWithin(asTx(db), {
        ...PARAMS,
        origin: HouseholdMembershipOrigin.JoinApproved,
        addedById: 'user-approver',
      });

      expect(db.householdMember.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            origin: HouseholdMembershipOrigin.JoinApproved,
            addedById: 'user-approver',
          }),
        }),
      );
    });

    it('returns the existing row without inserting when the user is already a member', async () => {
      const existing = makeMember({ id: 'member-existing', userId: 'user-2' });
      db.householdMember.findUnique.mockResolvedValue(existing as never);

      const result = await service.addMemberWithin(asTx(db), PARAMS);

      expect(db.householdMember.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { householdId_userId: { householdId: 'hh-1', userId: 'user-2' } },
          include: MEMBER_INCLUDE,
        }),
      );
      expect(result.member).toBe(existing);
      expect(db.householdMember.create).not.toHaveBeenCalled();
    });

    // Silently applying the requested role would turn any invite link into a
    // privilege-escalation path. Role changes are updateMemberRole's job.
    it('leaves an existing member role untouched even when a different role is requested', async () => {
      const existing = makeMember({ id: 'member-existing', userId: 'user-2' });
      db.householdMember.findUnique.mockResolvedValue(existing as never);

      const result = await service.addMemberWithin(asTx(db), { ...PARAMS, role: SystemRole.HouseholdAdmin });

      expect(result.member.role?.role.name).toBe(SystemRole.HouseholdMember);
      expect(db.householdRole.upsert).not.toHaveBeenCalled();
      expect(db.householdRole.create).not.toHaveBeenCalled();
      expect(db.role.findUnique).not.toHaveBeenCalled();
    });

    // Recovery in place is impossible: Postgres has aborted the transaction, so
    // reading the winner's row back here would fail too. 409 and let the caller
    // retry the whole transaction into the pre-read.
    it('maps a concurrent duplicate insert to Conflict rather than re-reading', async () => {
      stubAdmissible();
      db.householdMember.create.mockRejectedValue(uniqueConstraintError());

      await expect(service.addMemberWithin(asTx(db), PARAMS)).rejects.toThrow(ConflictException);
      expect(db.householdMember.findUnique).toHaveBeenCalledTimes(1);
    });

    it('rethrows a non-unique write failure untouched', async () => {
      stubAdmissible();
      const failure = new Error('connection reset');
      db.householdMember.create.mockRejectedValue(failure);

      await expect(service.addMemberWithin(asTx(db), PARAMS)).rejects.toThrow(failure);
    });

    // Seed drift is a server misconfiguration, not a caller error — it must not
    // present as a permission or validation failure.
    it('surfaces an unprovisioned role as InternalServerError without writing', async () => {
      db.householdMember.findUnique.mockResolvedValue(null);
      db.role.findUnique.mockResolvedValue(null);

      await expect(service.addMemberWithin(asTx(db), PARAMS)).rejects.toThrow(InternalServerErrorException);
      expect(db.householdMember.create).not.toHaveBeenCalled();
    });

    // Both are the caller's post-commit contract. Asserted negatively because a
    // regression here is otherwise silent: invalidating inside the transaction
    // evicts a graph for a membership that may still roll back, and the 5-minute
    // TTL makes the resulting stale-grant window invisible.
    it('performs no ability-cache invalidation and emits nothing', async () => {
      stubAdmissible();

      await service.addMemberWithin(asTx(db), PARAMS);

      expect(permissions.invalidateUser).not.toHaveBeenCalled();
      expect(permissions.invalidateUsers).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('returns an empty softOverages list when no cap applies', async () => {
      stubAdmissible();

      await expect(service.addMemberWithin(asTx(db), PARAMS)).resolves.toEqual(
        expect.objectContaining({ softOverages: [] }),
      );
    });

    // Founder membership is created by `HouseholdService.create`, never here.
    // Accepting it would stamp a later admission as the household's creation —
    // the exact question the discriminant exists to answer. 500 rather than 400
    // because `origin` is never client-derived: every call site passes a literal.
    it('rejects the Founder origin as a server error, without writing', async () => {
      stubAdmissible();

      await expect(
        // Cast is the point: the parameter type already excludes Founder, so only
        // a cast or a dynamically resolved value could get here — and the runtime
        // guard has to catch those.
        service.addMemberWithin(asTx(db), {
          ...PARAMS,
          origin: HouseholdMembershipOrigin.Founder as unknown as AdmissibleMembershipOrigin,
        }),
      ).rejects.toThrow(InternalServerErrorException);

      expect(db.householdMember.create).not.toHaveBeenCalled();
      // Refused before any lock is taken, like the role guard.
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(quotas.consume).not.toHaveBeenCalled();
    });

    it.each([HouseholdMembershipOrigin.InviteAccepted, HouseholdMembershipOrigin.JoinApproved] as const)(
      'admits with the %s origin',
      async (origin: AdmissibleMembershipOrigin) => {
        stubAdmissible();

        await service.addMemberWithin(asTx(db), { ...PARAMS, origin });

        expect(db.householdMember.create).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ origin }) }),
        );
      },
    );

    describe('duplicate discrimination', () => {
      // Prisma reports `meta.target` as the mapped constraint name on some
      // provider/version combinations, the field-name array on others, and raw
      // column names elsewhere. All three must map to 409 or a genuine duplicate
      // becomes a 500 on the common path.
      it.each([
        ['the mapped constraint name', HOUSEHOLD_MEMBER_UNIQUE_CONSTRAINT],
        ['the field-name array', ['householdId', 'userId']],
        ['the raw column names', ['household_id', 'user_id']],
      ])('maps a duplicate reported as %s to Conflict', async (_label, target) => {
        stubAdmissible();
        db.householdMember.create.mockRejectedValue(uniqueConstraintError(target));

        await expect(service.addMemberWithin(asTx(db), PARAMS)).rejects.toThrow(ConflictException);
      });

      // The nested member/role create can raise P2002 from either generated
      // primary key today, and from whatever unique someone adds tomorrow.
      // Translating those to "already a member" would hide an unrelated database
      // failure behind a confidently wrong answer.
      it.each([
        ['a primary key collision', ['id']],
        ['an unrelated future unique', ['householdMemberId', 'roleId']],
        ['a single matching field without its pair', ['userId']],
      ])('rethrows a P2002 raised by %s rather than reporting Conflict', async (_label, target) => {
        stubAdmissible();
        const error = uniqueConstraintError(target);
        db.householdMember.create.mockRejectedValue(error);

        await expect(service.addMemberWithin(asTx(db), PARAMS)).rejects.toBe(error);
      });

      it('rethrows a P2002 with no target rather than guessing', async () => {
        stubAdmissible();
        const error = new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: PrismaError.UniqueConstraintViolation,
          clientVersion: 'test',
        });
        db.householdMember.create.mockRejectedValue(error);

        await expect(service.addMemberWithin(asTx(db), PARAMS)).rejects.toBe(error);
      });
    });

    describe('quota gate (#159)', () => {
      it('consumes one member against household_member_count on the caller transaction', async () => {
        stubAdmissible();

        await service.addMemberWithin(asTx(db), PARAMS);

        expect(quotas.consume).toHaveBeenCalledWith(
          'household_member_count',
          1n,
          { userId: 'actor-1', householdId: 'hh-1' },
          db,
        );
      });

      // `QuotaCheckContext.userId` is the acting principal, and neither
      // parameter is reliably that: for `InviteAccepted` the actor is the
      // invitee while `addedById` is the absent inviter, and for `JoinApproved`
      // it is the approver. Passing either would charge the wrong principal the
      // moment a User-scope cap exists on this resource.
      it('charges the acting principal, not the joining user or the admitting actor', async () => {
        stubAdmissible();
        abilityService.getActingUserId.mockReturnValue('actor-approver');

        await service.addMemberWithin(asTx(db), { ...PARAMS, userId: 'user-2', addedById: 'user-inviter' });

        expect(quotas.consume).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.objectContaining({ userId: 'actor-approver' }),
          expect.anything(),
        );
      });

      // The advisory lock `consume` takes only holds for the life of the
      // transaction it is handed. Passing the base client would compile, pass a
      // naive assertion, and serialize nothing — two concurrent admissions would
      // both read the pre-image and both pass a full cap.
      it('hands consume the caller transaction, never the base client', async () => {
        stubAdmissible();
        const tx = {
          ...db,
          $queryRaw: jest.fn().mockResolvedValue([{ id: 'hh-1' }]),
        } as unknown as MockDatabaseService;

        await service.addMemberWithin(asTx(tx), PARAMS);

        expect(quotas.consume).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), tx);
      });

      // Charging an idempotent return would let a client walk a household past
      // its cap by replaying a single accept — the roster never grows, but the
      // usage counter would.
      it('does not consume when the user is already a member', async () => {
        const existing = makeMember({ id: 'member-existing', userId: 'user-2' });
        db.householdMember.findUnique.mockResolvedValue(existing as never);

        const result = await service.addMemberWithin(asTx(db), PARAMS);

        expect(quotas.consume).not.toHaveBeenCalled();
        expect(result.softOverages).toEqual([]);
      });

      // NOTE (#288): the status assertion below pins 402, which is inherited
      // from `QuotaExceededException` rather than chosen for this path. When
      // that taxonomy is settled, this is the assertion to update — the
      // machine-readable fields underneath it are the stable contract and
      // should survive whatever the status becomes.
      it('rejects with QuotaExceededException carrying the binding constraint, without writing', async () => {
        stubAdmissible();
        quotas.consume.mockResolvedValue(
          quotaDecision({ allowed: false, scope: QuotaScope.Household, limit: 8n, currentUsage: 8n }),
        );

        // One invocation, awaited twice, so the call-count assertion below stays
        // meaningful.
        const attempt = service.addMemberWithin(asTx(db), PARAMS);

        await expect(attempt).rejects.toThrow(QuotaExceededException);
        await expect(attempt).rejects.toMatchObject({
          status: Http.PaymentRequired,
          resource: 'household_member_count',
          limit: 8n,
          currentUsage: 8n,
          attemptedAmount: 1n,
        });

        expect(db.householdMember.create).not.toHaveBeenCalled();
        // Pre-read plus the confirming re-read: a cap breach is only reported
        // once the membership is confirmed still absent.
        expect(db.householdMember.findUnique).toHaveBeenCalledTimes(2);
      });

      // A denial while a concurrent admission of the SAME user committed is not a
      // full household — the usage measured against already includes the row this
      // call was about to insert. Reporting 402 would tell the caller their write
      // failed when it has effectively succeeded; for #163 that is an invitee
      // being told the household is full straight after joining it.
      it('returns the concurrently admitted row instead of reporting quota exhaustion', async () => {
        const winner = makeMember({ id: 'member-winner', userId: 'user-2' });
        db.role.findUnique.mockResolvedValue({ id: 'role-member' } as never);
        // Absent at the pre-read, present once the quota lock is granted.
        db.householdMember.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(winner as never);
        quotas.consume.mockResolvedValue(
          quotaDecision({ allowed: false, scope: QuotaScope.Household, limit: 8n, currentUsage: 8n }),
        );

        const result = await service.addMemberWithin(asTx(db), PARAMS);

        expect(result.member).toBe(winner);
        // Nothing was admitted by this call, so it crossed no soft cap.
        expect(result.softOverages).toEqual([]);
        expect(db.householdMember.create).not.toHaveBeenCalled();
        expect(db.householdMember.findUnique).toHaveBeenCalledTimes(2);
      });

      // Every other case here uses the unconstrained default decision, where
      // `scope`, `limit`, and `currentUsage` are all null. Without this, an
      // implementation that refused whenever a cap APPLIED — rather than when one
      // was exceeded — would satisfy the whole suite.
      it('admits the member when an enforced cap still has headroom', async () => {
        stubAdmissible();
        quotas.consume.mockResolvedValue(
          quotaDecision({ allowed: true, scope: QuotaScope.Household, limit: 8n, currentUsage: 7n }),
        );

        const result = await service.addMemberWithin(asTx(db), PARAMS);

        expect(db.householdMember.create).toHaveBeenCalled();
        expect(result.member.id).toBe('member-new');
      });

      // Consuming after the insert would take the advisory lock too late to
      // serialize anything, so the order is part of the contract, not an
      // incidental arrangement of statements.
      it('consumes before inserting, not after', async () => {
        stubAdmissible();

        await service.addMemberWithin(asTx(db), PARAMS);

        const consumeOrder = quotas.consume.mock.invocationCallOrder[0];
        const createOrder = db.householdMember.create.mock.invocationCallOrder[0];
        expect(consumeOrder).toBeLessThan(createOrder);
      });

      // Emitting inside the caller's transaction would warn about usage a
      // rollback undoes. The seam returns them; the caller emits post-commit.
      it('returns soft overages rather than emitting them', async () => {
        const overage: QuotaSoftOverageEvent = {
          scope: QuotaScope.Household,
          scopeId: 'hh-1',
          resource: 'household_member_count',
          currentUsage: '8',
          attemptedAmount: '1',
          limit: '8',
        };
        stubAdmissible();
        quotas.consume.mockResolvedValue(quotaDecision({ softOverage: true, softOverages: [overage] }));

        const result = await service.addMemberWithin(asTx(db), PARAMS);

        expect(result.softOverages).toEqual([overage]);
        expect(quotas.emitSoftOverages).not.toHaveBeenCalled();
      });
    });
  });

  /**
   * Guards #239's first gap without a database. `$queryRaw` is mocked, so the
   * lock SQL never executes and a later `@map` rename would pass every other
   * test in this suite. The checked-in Prisma models are the authoritative source
   * of mapped names — Prisma 7's client generator exposes no runtime DMMF and its
   * output is gitignored, so the schema files are also the only source available.
   *
   * Covers both raw statements the service issues: the owner lock (#157/#158)
   * and the household share lock the member-creation seam takes (#276).
   *
   * Still does NOT show either lock serializes; that needs two real concurrent
   * transactions (#239).
   */
  describe('raw lock SQL', () => {
    const findSchemaDir = (): string => {
      let dir = __dirname;

      for (let depth = 0; depth < 10; depth += 1) {
        const candidate = join(dir, 'prisma', 'models');

        try {
          if (statSync(candidate).isDirectory()) {
            return candidate;
          }
        } catch {
          // Not this level; keep walking toward the workspace root.
        }

        dir = resolve(dir, '..');
      }

      throw new Error('Could not locate prisma/models by walking up from the spec directory');
    };

    // The three models the lock's SQL touches, read by name. An earlier version
    // walked `prisma/models` recursively and read every `.prisma` file, which was
    // slower and — worse — silently found nothing if a model moved. Naming them
    // fails loudly with the missing path instead.
    const MODEL_FILES = [
      'household/household-role.prisma',
      'household/household-member.prisma',
      'household/household.prisma',
      'permissions/role.prisma',
    ];

    const readSchema = (): string => {
      const dir = findSchemaDir();

      return MODEL_FILES.map((file) => readFileSync(join(dir, file), 'utf8')).join('\n');
    };

    const modelBody = (schema: string, model: string): string => {
      const body = new RegExp(`model\\s+${model}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(schema)?.[1];
      expect(body).toBeDefined();

      return body as string;
    };

    /** `@@map` name, or the model name when unmapped. */
    const table = (schema: string, model: string): string =>
      /@@map\("([^"]+)"\)/.exec(modelBody(schema, model))?.[1] ?? model;

    /** `@map` name for one field, or the field name when unmapped. */
    const column = (schema: string, model: string, field: string): string => {
      const line = new RegExp(`^\\s*${field}\\b.*$`, 'm').exec(modelBody(schema, model))?.[0] ?? '';

      return /@map\("([^"]+)"\)/.exec(line)?.[1] ?? field;
    };

    const captureLockSql = async (): Promise<string> => {
      db.householdMember.findFirst.mockResolvedValue(makeOwner());
      db.excludedGame.deleteMany.mockResolvedValue({ count: 0 } as never);
      db.householdRole.deleteMany.mockResolvedValue({ count: 1 } as never);
      db.householdMember.delete.mockResolvedValue(makeOwner() as never);
      stubRawQueries({ owners: ['member-1', 'member-2'] });

      await service.removeMember('hh-1', 'member-1');

      const ownerLock = db.$queryRaw.mock.calls
        .map((call: unknown[]) => call[0])
        .find((query: unknown) => !isHouseholdLockSql(query));
      expect(ownerLock).toBeDefined();

      return rawText(ownerLock);
    };

    it('references only identifiers the Prisma models actually map to', async () => {
      const text = await captureLockSql();
      const schema = readSchema();

      // Word-boundary matching, so `roles` cannot be satisfied by the `roles`
      // inside `household_roles`.
      for (const identifier of [
        table(schema, 'HouseholdRole'),
        table(schema, 'HouseholdMember'),
        table(schema, 'Role'),
        column(schema, 'HouseholdRole', 'householdMemberId'),
        column(schema, 'HouseholdRole', 'roleId'),
        column(schema, 'HouseholdMember', 'householdId'),
      ]) {
        expect(text).toMatch(new RegExp(`\\b${identifier}\\b`));
      }
    });

    it('locks the household_roles rows rather than merely reading them', async () => {
      // Without FOR UPDATE two concurrent owner transitions both pass their
      // checks and the household is left ownerless.
      await expect(captureLockSql()).resolves.toMatch(/FOR UPDATE OF hr/);
    });

    describe('household share lock', () => {
      const captureHouseholdLockSql = async (): Promise<string> => {
        db.householdMember.findUnique.mockResolvedValue(null);
        db.role.findUnique.mockResolvedValue({ id: 'role-member' } as never);
        db.householdMember.create.mockResolvedValue(makeMember() as never);

        await service.addMemberWithin(db as unknown as Prisma.TransactionClient, {
          householdId: 'hh-1',
          userId: 'user-2',
          origin: HouseholdMembershipOrigin.InviteAccepted,
          addedById: 'user-inviter',
        });

        const query = db.$queryRaw.mock.calls.map((call: unknown[]) => call[0]).find(isHouseholdLockSql);
        expect(query).toBeDefined();

        return rawText(query);
      };

      it('references only identifiers the Prisma models actually map to', async () => {
        const text = await captureHouseholdLockSql();
        const schema = readSchema();

        for (const identifier of [
          table(schema, 'Household'),
          column(schema, 'Household', 'deletedAt'),
          column(schema, 'Household', 'id'),
        ]) {
          expect(text).toMatch(new RegExp(`\\b${identifier}\\b`));
        }
      });

      it('excludes soft-deleted households and locks the row rather than merely reading it', async () => {
        // FOR KEY SHARE — which the FK insert already takes implicitly — does
        // NOT block the non-key UPDATE that soft-deletes. FOR SHARE does, and
        // that gap is the whole race this statement closes.
        const text = await captureHouseholdLockSql();

        expect(text).toMatch(/deleted_at IS NULL/);
        expect(text).toMatch(/FOR SHARE/);
        expect(text).not.toMatch(/FOR KEY SHARE/);
      });
    });
  });
});
