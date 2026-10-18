import { DatabaseService, InviteType, QuotaScope } from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { QuotaResourceRegistry } from './quota-resource.registry';

describe('QuotaResourceRegistry', () => {
  let registry: QuotaResourceRegistry;
  let db: MockDatabaseService;

  beforeEach(() => {
    db = createMockDatabaseService();
    registry = new QuotaResourceRegistry(db as unknown as DatabaseService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('catalogue', () => {
    it('recognizes registered resources and rejects unknown strings', () => {
      expect(registry.has('household_member_count')).toBe(true);
      expect(registry.has('webhook_subscription_count')).toBe(true);
      expect(registry.has('household_invite_daily_count')).toBe(true);
      expect(registry.has('not_a_resource')).toBe(false);
    });

    it('exposes every registered key', () => {
      expect(registry.keys()).toEqual(
        expect.arrayContaining([
          'household_member_count',
          'webhook_subscription_count',
          'storage_bytes',
          'plugin_install_count',
          'household_invite_daily_count',
        ]),
      );
    });

    it('declares the corrected scopes (webhooks User, storage Server+User)', () => {
      expect(registry.require('webhook_subscription_count').applicableScopes).toEqual([QuotaScope.User]);
      expect(registry.require('storage_bytes').applicableScopes).toEqual([QuotaScope.Server, QuotaScope.User]);
    });

    it('measures household invites per inviter and per household', () => {
      expect(registry.require('household_invite_daily_count').applicableScopes).toEqual([
        QuotaScope.User,
        QuotaScope.Household,
      ]);
    });
  });

  describe('requireUsage', () => {
    it('returns a provider for enforceable resources', () => {
      expect(typeof registry.requireUsage('household_member_count')).toBe('function');
      expect(typeof registry.requireUsage('webhook_subscription_count')).toBe('function');
      expect(typeof registry.requireUsage('storage_bytes')).toBe('function');
      expect(typeof registry.requireUsage('household_invite_daily_count')).toBe('function');
    });

    it('throws for registered-but-pending resources', () => {
      expect(() => registry.requireUsage('plugin_install_count')).toThrow(/not yet enforceable/);
    });
  });

  describe('usage providers', () => {
    it('counts household members for the given household', async () => {
      db.householdMember.count.mockResolvedValue(3);

      const usage = await registry.requireUsage('household_member_count')(QuotaScope.Household, 'hh_1');

      expect(db.householdMember.count).toHaveBeenCalledWith({ where: { householdId: 'hh_1' } });
      expect(usage).toBe(3n);
    });

    it("counts the user's live (non-deleted) webhook subscriptions", async () => {
      db.webhookSubscription.count.mockResolvedValue(2);

      const usage = await registry.requireUsage('webhook_subscription_count')(QuotaScope.User, 'user_1');

      expect(db.webhookSubscription.count).toHaveBeenCalledWith({
        where: { createdById: 'user_1', deletedAt: null },
      });
      expect(usage).toBe(2n);
    });

    it('sums bytes owned by the user at User scope', async () => {
      db.mediaObject.aggregate.mockResolvedValue({ _sum: { sizeBytes: 5000n } } as never);

      const usage = await registry.requireUsage('storage_bytes')(QuotaScope.User, 'user_1');

      expect(db.mediaObject.aggregate).toHaveBeenCalledWith({
        _sum: { sizeBytes: true },
        where: { ownerId: 'user_1' },
      });
      expect(usage).toBe(5000n);
    });

    it('sums all bytes at Server scope and treats an empty table as 0', async () => {
      db.mediaObject.aggregate.mockResolvedValue({ _sum: { sizeBytes: null } } as never);

      const usage = await registry.requireUsage('storage_bytes')(QuotaScope.Server, '*');

      expect(db.mediaObject.aggregate).toHaveBeenCalledWith({
        _sum: {
          sizeBytes: true,
        },
        where: {},
      });
      expect(usage).toBe(0n);
    });

    it('throws for an unsupported storage scope', async () => {
      await expect(registry.requireUsage('storage_bytes')(QuotaScope.Household, 'h1')).rejects.toThrow(
        /not defined for scope/,
      );
    });

    describe('household invites over the last 24 hours', () => {
      const NOW = new Date('2026-10-14T12:00:00Z');
      const DAY_BEFORE = new Date('2026-10-13T12:00:00Z');

      beforeEach(() => {
        jest.useFakeTimers({ now: NOW });
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      it('counts the invites a user sent, whatever their status or mark', async () => {
        db.invite.count.mockResolvedValue(4);

        const usage = await registry.requireUsage('household_invite_daily_count')(QuotaScope.User, 'user_1');

        expect(db.invite.count).toHaveBeenCalledWith({
          where: { type: InviteType.Household, inviterId: 'user_1', createdAt: { gt: DAY_BEFORE } },
        });
        expect(usage).toBe(4n);
      });

      it('counts the invites a household made: sent directly, or approved, in the window', async () => {
        db.invite.count.mockResolvedValue(7);

        const usage = await registry.requireUsage('household_invite_daily_count')(QuotaScope.Household, 'hh_1');

        expect(db.invite.count).toHaveBeenCalledWith({
          where: {
            type: InviteType.Household,
            householdId: 'hh_1',
            OR: [{ needsApproval: false, createdAt: { gt: DAY_BEFORE } }, { approvedAt: { gt: DAY_BEFORE } }],
          },
        });
        expect(usage).toBe(7n);
      });

      it('counts on the transaction it is handed', async () => {
        const tx = createMockDatabaseService();
        tx.invite.count.mockResolvedValue(1);

        await registry.requireUsage('household_invite_daily_count')(QuotaScope.User, 'user_1', tx as never);

        expect(tx.invite.count).toHaveBeenCalledTimes(1);
        expect(db.invite.count).not.toHaveBeenCalled();
      });

      it('throws for a scope it is not measured in', async () => {
        await expect(registry.requireUsage('household_invite_daily_count')(QuotaScope.Server, '*')).rejects.toThrow(
          /not defined for scope/,
        );
      });
    });
  });
});
