import { HouseholdMember, Prisma, QuotaScope, type Quota } from '@bge/database';
import type { AppAbility } from '@bge/permissions';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { createPrismaAbility } from '@casl/prisma';
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

  beforeEach(async () => {
    registry = { has: jest.fn(), require: jest.fn(), requireUsage: jest.fn() };
    emitter = { emit: jest.fn() };

    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [
        QuotaService,
        { provide: QuotaResourceRegistry, useValue: registry },
        { provide: EventEmitter2, useValue: emitter },
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

  describe('setQuota', () => {
    const ABILITIES: AppAbility[] = [createPrismaAbility([]) as AppAbility]; // rules-free ability; accessibleBy resolves via the mocked count

    beforeEach(() => {
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

      const view = await service.setQuota(
        QuotaScope.Household,
        null,
        'household_member_count',
        { limit: '8' },
        'admin_1',
        ABILITIES,
      );

      expect(db.quota.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            scope_scopeId_resource: { scope: QuotaScope.Household, scopeId: '*', resource: 'household_member_count' },
          },
          create: expect.objectContaining({
            scopeId: '*',
            limit: 8n,
            householdId: null,
            createdById: 'admin_1',
            updatedById: 'admin_1',
          }),
          update: expect.objectContaining({ updatedById: 'admin_1' }),
        }),
      );
      expect(view).toMatchObject({ scopeId: null, limit: '8' });
      expect(emitter.emit).toHaveBeenCalledWith(
        QuotaEvents.Updated,
        expect.objectContaining({ scope: QuotaScope.Household, scopeId: null, limit: '8' }),
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

      await service.setQuota(
        QuotaScope.HouseholdMember,
        MEMBER_ID,
        'storage_bytes',
        { limit: '1024' },
        'admin_1',
        ABILITIES,
      );

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

      await expect(
        service.setQuota(QuotaScope.Server, null, 'storage_bytes', { limit: '1' }, 'hh_admin', ABILITIES),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects an empty ability set', async () => {
      await expect(
        service.setQuota(QuotaScope.User, USER_ID, 'storage_bytes', { limit: '1' }, 'u', []),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects an unknown resource', async () => {
      registry.has.mockReturnValue(false);
      await expect(
        service.setQuota(QuotaScope.User, USER_ID, 'storage_bytes', { limit: '1' }, 'admin_1', ABILITIES),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a Server-scope quota that carries an instance target', async () => {
      await expect(
        service.setQuota(QuotaScope.Server, 'nope', 'storage_bytes', { limit: '1' }, 'admin_1', ABILITIES),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('updates only the provided fields without a limit, leaving others untouched', async () => {
      db.quota.findUnique.mockResolvedValue({ id: 'q_1' } as Quota);
      db.quota.update.mockResolvedValue(
        makeQuota({ scope: QuotaScope.User, scopeId: USER_ID, limit: 5n, enforced: false }),
      );

      await service.setQuota(QuotaScope.User, USER_ID, 'storage_bytes', { enforced: false }, 'admin_1', ABILITIES);

      expect(db.quota.upsert).not.toHaveBeenCalled();
      expect(db.quota.update).toHaveBeenCalledWith({
        where: { id: 'q_1' },
        data: expect.objectContaining({ enforced: false, updatedById: 'admin_1' }),
      });
      const { data } = db.quota.update.mock.calls[0][0] as Prisma.QuotaUpdateArgs;

      expect(data).not.toHaveProperty('description');
      expect(data).not.toHaveProperty('limit');
    });

    it('rejects a limit-less update when the row does not exist', async () => {
      db.quota.findUnique.mockResolvedValue(null);

      await expect(
        service.setQuota(QuotaScope.User, USER_ID, 'storage_bytes', { description: 'x' }, 'admin_1', ABILITIES),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a User-scope type-level default (null target → sentinel)', async () => {
      db.quota.upsert.mockResolvedValue(makeQuota({ scope: QuotaScope.User, scopeId: '*', limit: 5n }));

      await service.setQuota(QuotaScope.User, null, 'storage_bytes', { limit: '5' }, 'admin_1', ABILITIES);

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
        service.setQuota(QuotaScope.User, USER_ID, 'household_member_count', { limit: '1' }, 'admin_1', ABILITIES),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('collapses a missing HouseholdMember target to Forbidden (no existence oracle)', async () => {
      db.householdMember.findUnique.mockResolvedValue(null);

      await expect(
        service.setQuota(
          QuotaScope.HouseholdMember,
          'hm_missing',
          'storage_bytes',
          { limit: '1024' },
          'hh_admin',
          ABILITIES,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // never reaches the row write — resolution fails before the transaction
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('collapses a missing Household target to Forbidden too', async () => {
      db.household.findUnique.mockResolvedValue(null);

      await expect(
        service.setQuota(QuotaScope.Household, 'hh_missing', 'storage_bytes', { limit: '1024' }, 'hh_admin', ABILITIES),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('getQuotas', () => {
    it('returns an empty list when the caller has no abilities', async () => {
      await expect(service.getQuotas([])).resolves.toEqual([]);
      expect(db.quota.findMany).not.toHaveBeenCalled();
    });
  });
});
