import { Action } from '@bge/database';
import { subject } from '@casl/ability';
import { Test, TestingModule } from '@nestjs/testing';
import { AbilityFactory } from './ability.factory';
import type { ApiKeyScopeWithPermission, ApikeyWithScopes } from './interfaces';

describe('AbilityFactory.createForApiKey', () => {
  let factory: AbilityFactory;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AbilityFactory],
    }).compile();

    factory = module.get(AbilityFactory);
  });

  describe('createForApiKey', () => {
    describe('empty scopes', () => {
      it('produces no rules when the scopes array is empty', () => {
        const ability = factory.createForApiKey(makeApiKey([]));
        expect(ability.rules).toHaveLength(0);
      });

      it('denies all actions when scopes are empty', () => {
        const ability = factory.createForApiKey(makeApiKey([]));
        expect(ability.can(Action.read, 'Household')).toBe(false);
      });
    });

    describe('unpinned scope (resourceId = null)', () => {
      it('grants the action on the full subject type', () => {
        const ability = factory.createForApiKey(makeApiKey([makeScope(Action.read, 'Household')]));
        expect(ability.can(Action.read, 'Household')).toBe(true);
      });

      it('does not add a condition — row filtering is delegated to userAbility', () => {
        const ability = factory.createForApiKey(makeApiKey([makeScope(Action.read, 'Household')]));
        expect(ability.rules[0].conditions).toBeUndefined();
      });

      it('does not grant actions on other subjects', () => {
        const ability = factory.createForApiKey(makeApiKey([makeScope(Action.read, 'Household')]));
        expect(ability.can(Action.read, 'Event')).toBe(false);
      });

      it('adds a cannot rule for an inverted unpinned scope', () => {
        const ability = factory.createForApiKey(makeApiKey([makeScope(Action.delete, 'Household', null, true)]));
        expect(ability.cannot(Action.delete, 'Household')).toBe(true);
      });
    });

    describe('pinned scope (resourceId is set)', () => {
      it('generates a rule with an { id } condition matching the pinned resourceId', () => {
        const ability = factory.createForApiKey(makeApiKey([makeScope(Action.read, 'Household', 'hh-alpha')]));
        expect(ability.rules[0].conditions).toEqual({ id: 'hh-alpha' });
      });

      it('allows access to the pinned resource', () => {
        const ability = factory.createForApiKey(makeApiKey([makeScope(Action.read, 'Household', 'hh-alpha')]));
        expect(ability.can(Action.read, subject('Household', { id: 'hh-alpha' }))).toBe(true);
      });

      it('denies access to a different resource of the same type', () => {
        const ability = factory.createForApiKey(makeApiKey([makeScope(Action.read, 'Household', 'hh-alpha')]));
        expect(ability.can(Action.read, subject('Household', { id: 'hh-beta' }))).toBe(false);
      });

      it('adds a cannot rule with an { id } condition for an inverted pinned scope', () => {
        const ability = factory.createForApiKey(makeApiKey([makeScope(Action.delete, 'Household', 'hh-alpha', true)]));
        expect(ability.rules[0].conditions).toEqual({ id: 'hh-alpha' });
        expect(ability.cannot(Action.delete, subject('Household', { id: 'hh-alpha' }))).toBe(true);
      });
    });

    describe('multiple scopes', () => {
      it('emits one rule per scope', () => {
        const scopes = [
          makeScope(Action.read, 'Household'),
          makeScope(Action.update, 'Household', 'hh-1'),
          makeScope(Action.read, 'Event'),
        ];
        const ability = factory.createForApiKey(makeApiKey(scopes));
        expect(ability.rules).toHaveLength(3);
      });

      it('correctly mixes unpinned and pinned scopes for the same subject', () => {
        // Unpinned read + pinned update on a specific household
        const scopes = [makeScope(Action.read, 'Household'), makeScope(Action.update, 'Household', 'hh-1')];
        const ability = factory.createForApiKey(makeApiKey(scopes));

        expect(ability.can(Action.read, 'Household')).toBe(true);
        expect(ability.can(Action.update, subject('Household', { id: 'hh-1' }))).toBe(true);
        expect(ability.can(Action.update, subject('Household', { id: 'hh-2' }))).toBe(false);
      });

      it('scopes for different subjects are independent', () => {
        const scopes = [makeScope(Action.read, 'Household', 'hh-1'), makeScope(Action.read, 'Event', 'ev-1')];
        const ability = factory.createForApiKey(makeApiKey(scopes));

        expect(ability.can(Action.read, subject('Household', { id: 'hh-1' }))).toBe(true);
        expect(ability.can(Action.read, subject('Event', { id: 'ev-1' }))).toBe(true);
        // Cross-subject: Household scope does not bleed into Event
        expect(ability.can(Action.read, subject('Event', { id: 'hh-1' }))).toBe(false);
      });

      it('a cannot rule from one scope does not affect a can rule from another', () => {
        const scopes = [
          makeScope(Action.read, 'Household'),
          makeScope(Action.delete, 'Household', null, true), // inverted
        ];
        const ability = factory.createForApiKey(makeApiKey(scopes));

        expect(ability.can(Action.read, 'Household')).toBe(true);
        expect(ability.cannot(Action.delete, 'Household')).toBe(true);
      });
    });
  });

  describe('createForSystem', () => {
    it('grants manage on all subjects', () => {
      const ability = factory.createForSystem('cron:occurrence-cleanup');

      expect(ability.can(Action.manage, 'all')).toBe(true);
    });

    it('permits every action on every resource (manage:all expansion)', () => {
      const ability = factory.createForSystem('migration:backfill');

      expect(ability.can(Action.read, 'Household')).toBe(true);
      expect(ability.can(Action.create, 'Event')).toBe(true);
      expect(ability.can(Action.update, 'Game')).toBe(true);
      expect(ability.can(Action.delete, 'EventOccurrence')).toBe(true);
    });

    it('is unconditional — applies to any specific instance regardless of fields', () => {
      const ability = factory.createForSystem('scheduled:reminder');

      expect(ability.can(Action.update, subject('Event', { id: 'evt-anything' }))).toBe(true);
    });

    it('does not vary with the reason (reason is audit-only for now)', () => {
      const a = factory.createForSystem('reason-a');
      const b = factory.createForSystem('reason-b');

      expect(a.can(Action.delete, 'Household')).toBe(b.can(Action.delete, 'Household'));
    });
  });
});

function makePermissionStub(
  action: Action,
  subject: string,
  inverted = false,
): ApiKeyScopeWithPermission['permission'] {
  return { action, subject, inverted };
}

function makeScope(
  action: Action,
  subject: string,
  resourceId: string | null = null,
  inverted = false,
): ApiKeyScopeWithPermission {
  return {
    id: `scope-${Math.random()}`,
    apiKeyId: 'key-1',
    permissionId: `perm-${Math.random()}`,
    resourceType: subject as ApiKeyScopeWithPermission['resourceType'], // ResourceType enum value when real
    resourceId,
    createdAt: new Date(),
    permission: makePermissionStub(action, subject, inverted),
  };
}

function makeApiKey(scopes: ApiKeyScopeWithPermission[] = []): ApikeyWithScopes {
  return {
    id: 'key-1',
    key: 'bge_test_key',
    referenceId: 'user-1',
    configId: 'config-1',
    permissions: 'manage',
    name: 'Test Key',
    start: null,
    prefix: null,
    enabled: true,
    refillInterval: null,
    refillAmount: null,
    lastRefillAt: null,
    rateLimitEnabled: true,
    rateLimitTimeWindow: 86400000,
    rateLimitMax: 10,
    requestCount: 0,
    remaining: null,
    lastRequest: null,
    metadata: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    scopes,
  };
}
