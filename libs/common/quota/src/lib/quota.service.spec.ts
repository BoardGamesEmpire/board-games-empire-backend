import { Action, HouseholdMember, Prisma, QuotaScope, ResourceType, type Quota } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import {
  createMockAbilityService,
  createTestingModuleWithDb,
  MOCK_RESOURCE_CONDITION,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { QuotaEvents } from './constants/quota-events.constant';
import type { QuotaResourceDefinition, QuotaUsageProvider } from './interfaces';
import { QuotaService } from './quota.service';
import { QuotaResourceRegistry } from './registry/quota-resource.registry';

type RegistryStub = {
  has: jest.MockedFunction<(resource: string) => boolean>;
  require: jest.MockedFunction<QuotaResourceRegistry['require']>;
  requireUsage: jest.MockedFunction<QuotaResourceRegistry['requireUsage']>;
};

const USER_ID = 'user_1';
const HOUSEHOLD_ID = 'hh_1';
const MEMBER_ID = 'hm_1';
const ACTOR_ID = 'admin_1';

/**
 * Minimal quota row factory — only the fields the resolver reads.
 */
function makeQuota(overrides: Partial<Quota> & Pick<Quota, 'scope' | 'scopeId' | 'limit'>): Quota {
  return {
    id: 'q_1',
    householdId: null,
    resource: 'storage_bytes',
    softOverage: false,
    enforced: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Quota;
}

describe('QuotaService', () => {
  let service: QuotaService;
  let db: MockDatabaseService;
  let registry: RegistryStub;
  let emitter: { emit: jest.Mock };
  let ability: MockAbilityService;

  beforeEach(async () => {
    registry = { has: jest.fn(), require: jest.fn(), requireUsage: jest.fn() };
    emitter = { emit: jest.fn() };
    ability = createMockAbilityService();

    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [
        QuotaService,
        { provide: QuotaResourceRegistry, useValue: registry },
        { provide: EventEmitter2, useValue: emitter },
        { provide: AbilityService, useValue: ability },
      ],
    });
    service = module.get(QuotaService);
    db = mockDb;
  });

  afterEach(() => jest.clearAllMocks());

  /**
   * Wires a single-scope definition + a per-scope usage map.
   */
  function defineResource(scopes: QuotaScope[], usageByScope: Partial<Record<QuotaScope, bigint>>): void {
    const usage: QuotaUsageProvider = async (scope) => usageByScope[scope] ?? 0n;
    registry.require.mockReturnValue({
      key: 'storage_bytes',
      applicableScopes: scopes,
      usage,
    } satisfies QuotaResourceDefinition);
    registry.requireUsage.mockReturnValue(usage);
  }

  describe('check', () => {
    it('allows with null limit when no quota row applies', async () => {
      defineResource([QuotaScope.User], { [QuotaScope.User]: 0n });
      db.quota.findMany.mockResolvedValue([]);

      const result = await service.check('storage_bytes', 1n, { userId: USER_ID });

      expect(result).toMatchObject({ allowed: true, scope: null, limit: null, constraints: [] });
    });

    it('rejects a negative amount', async () => {
      defineResource([QuotaScope.User], { [QuotaScope.User]: 0n });
      await expect(service.check('storage_bytes', -1n, { userId: USER_ID })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('hard-blocks when enforced, over limit, and not soft', async () => {
      defineResource([QuotaScope.User], { [QuotaScope.User]: 5n });
      db.quota.findMany.mockResolvedValue([makeQuota({ scope: QuotaScope.User, scopeId: USER_ID, limit: 5n })]);

      const result = await service.check('storage_bytes', 1n, { userId: USER_ID });

      expect(result.allowed).toBe(false);
      expect(result).toMatchObject({ scope: QuotaScope.User, limit: 5n, currentUsage: 5n });
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('allows but emits a warning on soft overage (warn-every)', async () => {
      defineResource([QuotaScope.User], { [QuotaScope.User]: 5n });
      db.quota.findMany.mockResolvedValue([
        makeQuota({ scope: QuotaScope.User, scopeId: USER_ID, limit: 5n, softOverage: true }),
      ]);

      const result = await service.check('storage_bytes', 1n, { userId: USER_ID });

      expect(result.allowed).toBe(true);
      expect(emitter.emit).toHaveBeenCalledWith(QuotaEvents.SoftOverage, {
        scope: QuotaScope.User,
        scopeId: USER_ID,
        resource: 'storage_bytes',
        currentUsage: '5',
        attemptedAmount: '1',
        limit: '5',
      });
    });

    it('treats a disabled (enforced: false) row as unlimited even when over', async () => {
      defineResource([QuotaScope.User], { [QuotaScope.User]: 100n });
      db.quota.findMany.mockResolvedValue([
        makeQuota({ scope: QuotaScope.User, scopeId: USER_ID, limit: 1n, enforced: false }),
      ]);

      const result = await service.check('storage_bytes', 1n, { userId: USER_ID });

      expect(result).toMatchObject({ allowed: true, limit: null, constraints: [] });
    });

    it('lets an instance row override the type-level default within a scope', async () => {
      defineResource([QuotaScope.Household], { [QuotaScope.Household]: 2n });
      db.quota.findMany.mockResolvedValue([
        makeQuota({ scope: QuotaScope.Household, scopeId: '*', limit: 100n }), // generous default
        makeQuota({ scope: QuotaScope.Household, scopeId: HOUSEHOLD_ID, limit: 2n }), // strict override
      ]);

      const result = await service.check('storage_bytes', 1n, { userId: USER_ID, householdId: HOUSEHOLD_ID });

      // 2 (usage) + 1 > 2 → the instance override binds, not the default 100.
      expect(result.allowed).toBe(false);
      expect(result).toMatchObject({ scope: QuotaScope.Household, limit: 2n });
    });

    it('evaluates scopes independently with per-scope usage; the tightest hard constraint binds', async () => {
      defineResource([QuotaScope.Server, QuotaScope.User], {
        [QuotaScope.Server]: 10n, // well under the server ceiling
        [QuotaScope.User]: 5n, // at the user ceiling
      });
      db.quota.findMany.mockResolvedValue([
        makeQuota({ scope: QuotaScope.Server, scopeId: '*', limit: 1000n }),
        makeQuota({ scope: QuotaScope.User, scopeId: USER_ID, limit: 5n }),
      ]);

      const result = await service.check('storage_bytes', 1n, { userId: USER_ID });

      expect(result.allowed).toBe(false);
      expect(result).toMatchObject({ scope: QuotaScope.User, limit: 5n, currentUsage: 5n });
      expect(result.constraints).toHaveLength(2);
    });

    it('throws when checking a registered-but-pending resource', async () => {
      registry.require.mockReturnValue({
        key: 'storage_bytes',
        applicableScopes: [QuotaScope.User],
      } satisfies QuotaResourceDefinition);
      registry.requireUsage.mockImplementation(() => {
        throw new Error('not yet enforceable');
      });

      await expect(service.check('storage_bytes', 1n, { userId: USER_ID })).rejects.toThrow('not yet enforceable');
    });

    it('applies a User-scope type-level default to any user (the * fallback)', async () => {
      defineResource([QuotaScope.User], { [QuotaScope.User]: 5n });
      db.quota.findMany.mockResolvedValue([
        makeQuota({ scope: QuotaScope.User, scopeId: '*', limit: 5n }), // default only, no instance row
      ]);

      const result = await service.check('storage_bytes', 1n, { userId: USER_ID });

      expect(result.allowed).toBe(false);
      expect(result).toMatchObject({ scope: QuotaScope.User, limit: 5n });
    });
  });

  describe('consume', () => {
    function makeTx() {
      return {
        quota: { findMany: jest.fn() },
        $executeRaw: jest.fn().mockResolvedValue(1),
      } as unknown as Prisma.TransactionClient;
    }

    it('allows under cap, locking the applicable scope and measuring under the tx', async () => {
      defineResource([QuotaScope.User], { [QuotaScope.User]: 5n });
      const tx = makeTx();
      (tx.quota.findMany as jest.Mock).mockResolvedValue([
        makeQuota({ scope: QuotaScope.User, scopeId: USER_ID, limit: 10n }),
      ]);

      const result = await service.consume('storage_bytes', 1n, { userId: USER_ID }, tx);

      expect(result.allowed).toBe(true);
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('hard-blocks under the lock when the re-measured usage is over', async () => {
      defineResource([QuotaScope.User], { [QuotaScope.User]: 5n });
      const tx = makeTx();
      (tx.quota.findMany as jest.Mock).mockResolvedValue([
        makeQuota({ scope: QuotaScope.User, scopeId: USER_ID, limit: 5n }),
      ]);

      const result = await service.consume('storage_bytes', 1n, { userId: USER_ID }, tx);
      expect(result).toMatchObject({ allowed: false, scope: QuotaScope.User, limit: 5n, currentUsage: 5n });
    });

    it('locks every applicable scope in ascending key order (deadlock-free)', async () => {
      defineResource([QuotaScope.Server, QuotaScope.User], { [QuotaScope.Server]: 1n, [QuotaScope.User]: 1n });
      const tx = makeTx();
      (tx.quota.findMany as jest.Mock).mockResolvedValue([
        makeQuota({ scope: QuotaScope.Server, scopeId: '*', limit: 1000n }),
        makeQuota({ scope: QuotaScope.User, scopeId: USER_ID, limit: 1000n }),
      ]);

      await service.consume('storage_bytes', 1n, { userId: USER_ID }, tx);

      expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
      const keys = (tx.$executeRaw as jest.Mock).mock.calls.map((call) => call[1] as bigint);
      expect(keys).toEqual([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    });

    it('passes the transaction executor to the usage provider (atomic re-measure)', async () => {
      const usage = jest.fn().mockResolvedValue(0n);
      registry.require.mockReturnValue({
        key: 'storage_bytes',
        applicableScopes: [QuotaScope.User],
        usage,
      } as unknown as QuotaResourceDefinition);
      registry.requireUsage.mockReturnValue(usage as unknown as QuotaUsageProvider);
      const tx = makeTx();
      (tx.quota.findMany as jest.Mock).mockResolvedValue([
        makeQuota({ scope: QuotaScope.User, scopeId: USER_ID, limit: 10n }),
      ]);

      await service.consume('storage_bytes', 1n, { userId: USER_ID }, tx);
      expect(usage).toHaveBeenCalledWith(QuotaScope.User, USER_ID, tx);
    });

    it('takes no lock and allows when no enforced row applies', async () => {
      defineResource([QuotaScope.User], { [QuotaScope.User]: 0n });
      const tx = makeTx();
      (tx.quota.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.consume('storage_bytes', 1n, { userId: USER_ID }, tx);
      expect(result).toMatchObject({ allowed: true, scope: null });
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('takes no lock when the resource has no applicable target in context', async () => {
      defineResource([QuotaScope.Household], { [QuotaScope.Household]: 0n });
      const tx = makeTx();

      const result = await service.consume('storage_bytes', 1n, { userId: USER_ID }, tx); // no householdId
      expect(result.allowed).toBe(true);
      expect(tx.quota.findMany).not.toHaveBeenCalled();
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('rejects a negative amount before touching the tx', async () => {
      defineResource([QuotaScope.User], { [QuotaScope.User]: 0n });
      const tx = makeTx();
      await expect(service.consume('storage_bytes', -1n, { userId: USER_ID }, tx)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });
  });

  describe('setQuota', () => {
    beforeEach(() => {
      ability.getActingUserId.mockReturnValue(ACTOR_ID);
      registry.has.mockReturnValue(true);
      db.$transaction.mockImplementation((c) => c(db));
      db.quota.count.mockResolvedValue(1); // authorized by default

      registry.require.mockReturnValue({
        key: 'storage_bytes',
        applicableScopes: [QuotaScope.Server, QuotaScope.Household, QuotaScope.HouseholdMember, QuotaScope.User],
      } satisfies QuotaResourceDefinition);
    });

    it('upserts a type-level default by the sentinel scopeId and emits quota.updated', async () => {
      db.quota.upsert.mockResolvedValue(
        makeQuota({ scope: QuotaScope.Household, scopeId: '*', resource: 'household_member_count', limit: 8n }),
      );

      const view = await service.setQuota(QuotaScope.Household, null, 'household_member_count', { limit: '8' });

      expect(ability.getActingUserId).toHaveBeenCalled();
      expect(db.quota.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            scope_scopeId_resource: { scope: QuotaScope.Household, scopeId: '*', resource: 'household_member_count' },
          },
          create: expect.objectContaining({
            scopeId: '*',
            limit: 8n,
            householdId: null,
            createdById: ACTOR_ID,
            updatedById: ACTOR_ID,
          }),
          update: expect.objectContaining({ updatedById: ACTOR_ID }),
        }),
      );
      expect(view).toMatchObject({ scopeId: null, limit: '8' });
      expect(emitter.emit).toHaveBeenCalledWith(
        QuotaEvents.Updated,
        expect.objectContaining({ scope: QuotaScope.Household, scopeId: null, limit: '8' }),
      );
    });

    it('authorizes the written row against the manage ability before committing', async () => {
      db.quota.upsert.mockResolvedValue(makeQuota({ scope: QuotaScope.Server, scopeId: '*', limit: 1n }));

      await service.setQuota(QuotaScope.Server, null, 'storage_bytes', { limit: '1' });

      expect(ability.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Quota, Action.manage);
      expect(db.quota.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ AND: [MOCK_RESOURCE_CONDITION] }) }),
      );
    });

    it('denormalizes householdId for a HouseholdMember instance', async () => {
      db.householdMember.findUnique.mockResolvedValue({ householdId: HOUSEHOLD_ID } as HouseholdMember);
      db.quota.upsert.mockResolvedValue(
        makeQuota({
          scope: QuotaScope.HouseholdMember,
          scopeId: MEMBER_ID,
          householdId: HOUSEHOLD_ID,
          resource: 'storage_bytes',
          limit: 1024n,
        }),
      );

      await service.setQuota(QuotaScope.HouseholdMember, MEMBER_ID, 'storage_bytes', { limit: '1024' });

      expect(db.householdMember.findUnique).toHaveBeenCalledWith({
        where: { id: MEMBER_ID },
        select: { householdId: true },
      });
      expect(db.quota.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ householdId: HOUSEHOLD_ID }) }),
      );
    });

    it('rolls back and forbids when the caller cannot manage the target row', async () => {
      db.quota.upsert.mockResolvedValue(makeQuota({ scope: QuotaScope.Server, scopeId: '*', limit: 1n }));
      db.quota.count.mockResolvedValue(0); // accessibleBy(manage) matches nothing

      await expect(service.setQuota(QuotaScope.Server, null, 'storage_bytes', { limit: '1' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('forbids when the caller has no manage ability (empty conditions)', async () => {
      db.quota.upsert.mockResolvedValue(makeQuota({ scope: QuotaScope.Server, scopeId: '*', limit: 1n }));
      ability.getCurrentResourceConditions.mockImplementation(() => {
        throw new ForbiddenException("You don't have permission to access this resource.");
      });

      await expect(service.setQuota(QuotaScope.Server, null, 'storage_bytes', { limit: '1' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('rejects an unknown resource', async () => {
      registry.has.mockReturnValue(false);
      await expect(service.setQuota(QuotaScope.User, USER_ID, 'storage_bytes', { limit: '1' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a Server-scope quota that carries an instance target', async () => {
      await expect(service.setQuota(QuotaScope.Server, 'nope', 'storage_bytes', { limit: '1' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('updates only the provided fields without a limit, leaving others untouched', async () => {
      db.quota.findUnique.mockResolvedValue({ id: 'q_1' } as Quota);
      db.quota.update.mockResolvedValue(
        makeQuota({ scope: QuotaScope.User, scopeId: USER_ID, limit: 5n, enforced: false }),
      );

      await service.setQuota(QuotaScope.User, USER_ID, 'storage_bytes', { enforced: false });

      expect(db.quota.upsert).not.toHaveBeenCalled();
      expect(db.quota.update).toHaveBeenCalledWith({
        where: { id: 'q_1' },
        data: expect.objectContaining({ enforced: false, updatedById: ACTOR_ID }),
      });
      const { data } = db.quota.update.mock.calls[0][0] as Prisma.QuotaUpdateArgs;

      expect(data).not.toHaveProperty('description');
      expect(data).not.toHaveProperty('limit');
    });

    it('rejects a limit-less update when the row does not exist', async () => {
      db.quota.findUnique.mockResolvedValue(null);

      await expect(
        service.setQuota(QuotaScope.User, USER_ID, 'storage_bytes', { description: 'x' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a User-scope type-level default (null target → sentinel)', async () => {
      db.quota.upsert.mockResolvedValue(makeQuota({ scope: QuotaScope.User, scopeId: '*', limit: 5n }));

      await service.setQuota(QuotaScope.User, null, 'storage_bytes', { limit: '5' });

      expect(db.quota.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { scope_scopeId_resource: { scope: QuotaScope.User, scopeId: '*', resource: 'storage_bytes' } },
        }),
      );
    });

    it('rejects a scope the resource is not measured in', async () => {
      registry.require.mockReturnValue({
        key: 'household_member_count',
        applicableScopes: [QuotaScope.Household],
      } satisfies QuotaResourceDefinition);
      await expect(
        service.setQuota(QuotaScope.User, USER_ID, 'household_member_count', { limit: '1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('collapses a missing HouseholdMember target to Forbidden (no existence oracle)', async () => {
      db.householdMember.findUnique.mockResolvedValue(null);

      await expect(
        service.setQuota(QuotaScope.HouseholdMember, 'hm_missing', 'storage_bytes', { limit: '1024' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // never reaches the row write — resolution fails before the transaction
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('collapses a missing Household target to Forbidden too', async () => {
      db.household.findUnique.mockResolvedValue(null);

      await expect(
        service.setQuota(QuotaScope.Household, 'hh_missing', 'storage_bytes', { limit: '1024' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('getQuotas', () => {
    it('lists the rows the caller can read, narrowed by the ability conditions', async () => {
      db.quota.findMany.mockResolvedValue([makeQuota({ scope: QuotaScope.User, scopeId: USER_ID, limit: 5n })]);

      const result = await service.getQuotas();

      expect(ability.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Quota, Action.read);
      expect(db.quota.findMany).toHaveBeenCalledWith({
        where: { AND: [MOCK_RESOURCE_CONDITION] },
        orderBy: [{ scope: 'asc' }, { resource: 'asc' }],
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ scope: QuotaScope.User, limit: '5' });
    });

    it('propagates ForbiddenException (never an unfiltered query) when the caller has no abilities', async () => {
      ability.getCurrentResourceConditions.mockImplementation(() => {
        throw new ForbiddenException("You don't have permission to access this resource.");
      });

      await expect(service.getQuotas()).rejects.toBeInstanceOf(ForbiddenException);
      expect(db.quota.findMany).not.toHaveBeenCalled();
    });
  });
});
