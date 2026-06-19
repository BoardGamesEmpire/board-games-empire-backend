import { DatabaseService, QuotaScope } from '@bge/database';
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
      expect(registry.has('not_a_resource')).toBe(false);
    });

    it('exposes every registered key', () => {
      expect(registry.keys()).toEqual(
        expect.arrayContaining([
          'household_member_count',
          'webhook_subscription_count',
          'storage_bytes',
          'plugin_install_count',
        ]),
      );
    });

    it('declares the corrected scopes (webhooks User, storage Server+User)', () => {
      expect(registry.require('webhook_subscription_count').applicableScopes).toEqual([QuotaScope.User]);
      expect(registry.require('storage_bytes').applicableScopes).toEqual([QuotaScope.Server, QuotaScope.User]);
    });
  });

  describe('requireUsage', () => {
    it('returns a provider for enforceable resources', () => {
      expect(typeof registry.requireUsage('household_member_count')).toBe('function');
      expect(typeof registry.requireUsage('webhook_subscription_count')).toBe('function');
    });

    it('throws for registered-but-pending resources', () => {
      expect(() => registry.requireUsage('storage_bytes')).toThrow(/not yet enforceable/);
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
  });
});
