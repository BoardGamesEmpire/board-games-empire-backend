import { Action, Permission, ResourceType } from '@bge/database';
import { subject } from '@casl/ability';
import { Test, TestingModule } from '@nestjs/testing';
import { AbilityFactory } from './ability.factory';
import type {
  ApiKeyScopeWithPermission,
  ApikeyWithScopes,
  RoleWithPermissions,
  Subjects,
  UserPermissionWithPermission,
  UserWithRoles,
} from './interfaces';

describe('AbilityFactory', () => {
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

  describe('createForUser', () => {
    it('builds an empty ability for a null user', () => {
      const ability = factory.createForUser(null);
      expect(ability.rules).toHaveLength(0);
    });

    describe('direct grants', () => {
      it('grants the action on the resourceType subject (type-level, no resourceId)', () => {
        const user = makeUser({
          permissions: [
            makeUserPermission({
              resourceType: ResourceType.Game,
              permission: { action: Action.read, subject: 'Game' },
            }),
          ],
        });

        const ability = factory.createForUser(user);
        expect(ability.can(Action.read, 'Game')).toBe(true);
      });

      it('pins the grant to the named instance when a resourceId is set', () => {
        const user = makeUser({
          permissions: [
            makeUserPermission({
              resourceType: ResourceType.Game,
              resourceId: 'game-1',
              permission: { action: Action.read, subject: 'Game' },
            }),
          ],
        });

        const ability = factory.createForUser(user);
        expect(ability.can(Action.read, asEntity('Game', { id: 'game-1' }))).toBe(true);
        expect(ability.can(Action.read, asEntity('Game', { id: 'game-2' }))).toBe(false);
      });

      it('merges rendered (user-context) conditions with the instance pin', () => {
        const user = makeUser({
          id: 'user-42',
          permissions: [
            makeUserPermission({
              resourceType: ResourceType.Household,
              resourceId: 'hh-1',
              permission: {
                action: Action.read,
                subject: 'Household',
                conditions: { members: { some: { userId: '{{ user.id }}' } } },
              },
            }),
          ],
        });

        const ability = factory.createForUser(user);
        expect(ability.rules.at(-1)?.conditions).toEqual({
          members: { some: { userId: 'user-42' } },
          id: 'hh-1',
        });
      });

      it('honors field-level restrictions', () => {
        const user = makeUser({
          permissions: [
            makeUserPermission({
              resourceType: ResourceType.EventAttendee,
              permission: { action: Action.update, subject: 'EventAttendee', fields: ['status', 'notes'] },
            }),
          ],
        });

        const ability = factory.createForUser(user);
        expect(ability.can(Action.update, 'EventAttendee', 'status')).toBe(true);
        expect(ability.can(Action.update, 'EventAttendee', 'location')).toBe(false);
      });
    });

    describe('direct denials (inverse)', () => {
      it('a role grant + an inverse UserPermission for the same subject → can() is false', () => {
        const user = makeUser({
          roles: [makeRole('User', [makePermission({ action: Action.read, subject: 'Household' })])],
          permissions: [
            makeUserPermission({
              inverted: true,
              resourceType: ResourceType.Household,
              permission: { action: Action.read, subject: 'Household' },
            }),
          ],
        });

        const ability = factory.createForUser(user);
        expect(ability.can(Action.read, 'Household')).toBe(false);
      });

      it('a resourceId-scoped denial blocks only the named instance, not the type', () => {
        const user = makeUser({
          roles: [makeRole('User', [makePermission({ action: Action.read, subject: 'Household' })])],
          permissions: [
            makeUserPermission({
              inverted: true,
              resourceType: ResourceType.Household,
              resourceId: 'hh-banned',
              permission: { action: Action.read, subject: 'Household' },
            }),
          ],
        });

        const ability = factory.createForUser(user);
        expect(ability.can(Action.read, asEntity('Household', { id: 'hh-banned' }))).toBe(false);
        expect(ability.can(Action.read, asEntity('Household', { id: 'hh-other' }))).toBe(true);
      });
    });

    describe('inverted resolution (override vs. inherit)', () => {
      it('inherits the base permission polarity when the override is null (base denial)', () => {
        const user = makeUser({
          roles: [makeRole('User', [makePermission({ action: Action.read, subject: 'Game' })])],
          permissions: [
            makeUserPermission({
              inverted: null,
              resourceType: ResourceType.Game,
              permission: { action: Action.read, subject: 'Game', inverted: true },
            }),
          ],
        });

        const ability = factory.createForUser(user);
        expect(ability.can(Action.read, 'Game')).toBe(false);
      });

      it('an explicit override of false flips a base denial into a grant', () => {
        const user = makeUser({
          permissions: [
            makeUserPermission({
              inverted: false,
              resourceType: ResourceType.Game,
              permission: { action: Action.read, subject: 'Game', inverted: true },
            }),
          ],
        });

        const ability = factory.createForUser(user);
        expect(ability.can(Action.read, 'Game')).toBe(true);
      });

      it('an explicit override of true flips a base grant into a denial', () => {
        const user = makeUser({
          roles: [makeRole('User', [makePermission({ action: Action.read, subject: 'Game' })])],
          permissions: [
            makeUserPermission({
              inverted: true,
              resourceType: ResourceType.Game,
              permission: { action: Action.read, subject: 'Game', inverted: false },
            }),
          ],
        });

        const ability = factory.createForUser(user);
        expect(ability.can(Action.read, 'Game')).toBe(false);
      });
    });

    describe('expiry', () => {
      it('does not apply an expired inverse denial', () => {
        const user = makeUser({
          roles: [makeRole('User', [makePermission({ action: Action.read, subject: 'Household' })])],
          permissions: [
            makeUserPermission({
              inverted: true,
              resourceType: ResourceType.Household,
              expiresAt: new Date(Date.now() - 60_000),
              permission: { action: Action.read, subject: 'Household' },
            }),
          ],
        });

        const ability = factory.createForUser(user);
        expect(ability.can(Action.read, 'Household')).toBe(true);
      });

      it('applies a not-yet-expired grant', () => {
        const user = makeUser({
          permissions: [
            makeUserPermission({
              resourceType: ResourceType.Game,
              expiresAt: new Date(Date.now() + 60_000),
              permission: { action: Action.read, subject: 'Game' },
            }),
          ],
        });

        const ability = factory.createForUser(user);
        expect(ability.can(Action.read, 'Game')).toBe(true);
      });

      it('treats a cache-deserialized (string) expiry like a Date', () => {
        const user = makeUser({
          permissions: [
            makeUserPermission({
              resourceType: ResourceType.Game,
              expiresAt: new Date(Date.now() + 60_000).toISOString() as unknown as Date,
              permission: { action: Action.read, subject: 'Game' },
            }),
          ],
        });

        expect(factory.createForUser(user).can(Action.read, 'Game')).toBe(true);
      });

      it('skips an already-passed string expiry', () => {
        const user = makeUser({
          roles: [makeRole('User', [makePermission({ action: Action.read, subject: 'Game' })])],
          permissions: [
            makeUserPermission({
              inverted: true,
              resourceType: ResourceType.Game,
              expiresAt: new Date(Date.now() - 60_000).toISOString() as unknown as Date,
              permission: { action: Action.read, subject: 'Game' },
            }),
          ],
        });

        expect(factory.createForUser(user).can(Action.read, 'Game')).toBe(true);
      });
    });

    describe("skips the 'all' wildcard subject", () => {
      it('does not apply a direct permission whose subject is the wildcard', () => {
        const user = makeUser({
          permissions: [
            makeUserPermission({
              resourceType: ResourceType.Game,
              permission: { action: Action.manage, subject: 'all' },
            }),
          ],
        });

        const ability = factory.createForUser(user);
        expect(ability.rules).toHaveLength(0);
        expect(ability.can(Action.manage, 'Game')).toBe(false);
      });
    });

    describe('precedence', () => {
      it('a direct grant overrides a role-level denial (UserPermission beats role)', () => {
        const user = makeUser({
          roles: [makeRole('User', [makePermission({ action: Action.read, subject: 'Game', inverted: true })])],
          permissions: [
            makeUserPermission({
              resourceType: ResourceType.Game,
              permission: { action: Action.read, subject: 'Game' },
            }),
          ],
        });

        const ability = factory.createForUser(user);
        expect(ability.can(Action.read, 'Game')).toBe(true);
      });

      it('a direct denial wins over a direct grant on the same target regardless of input order', () => {
        const user = makeUser({
          permissions: [
            // Denial listed first; the factory still applies denials last (deny-wins).
            makeUserPermission({
              inverted: true,
              resourceType: ResourceType.Game,
              resourceId: 'game-1',
              permission: { action: Action.read, subject: 'Game' },
            }),
            makeUserPermission({
              resourceType: ResourceType.Game,
              resourceId: 'game-1',
              permission: { action: Action.read, subject: 'Game' },
            }),
          ],
        });

        const ability = factory.createForUser(user);
        expect(ability.can(Action.read, asEntity('Game', { id: 'game-1' }))).toBe(false);
      });
    });

    describe('regression — role/household/event behavior', () => {
      it('leaves role-derived rules unchanged when there are no UserPermission rows', () => {
        const user = makeUser({
          roles: [makeRole('User', [makePermission({ action: Action.read, subject: 'Game' })])],
          permissions: [],
        });

        const ability = factory.createForUser(user);
        expect(ability.can(Action.read, 'Game')).toBe(true);
        expect(ability.rules).toHaveLength(1);
      });

      it('preserves householdMember-derived rules', () => {
        const user = makeUser({
          householdMember: [
            {
              householdId: 'hh-9',
              role: makeRole('HouseholdMember', [
                makePermission({ action: Action.read, subject: 'Household', conditions: { id: '{{ householdId }}' } }),
              ]),
            },
          ],
        });

        const ability = factory.createForUser(user);
        expect(ability.can(Action.read, asEntity('Household', { id: 'hh-9' }))).toBe(true);
      });

      it('tolerates a graph cached before the permissions field existed', () => {
        const user = makeUser({
          roles: [makeRole('User', [makePermission({ action: Action.read, subject: 'Game' })])],
        });
        // Simulate a pre-deploy cached graph that lacks the new field.
        delete (user as Partial<UserWithRoles>).permissions;

        const ability = factory.createForUser(user);
        expect(ability.can(Action.read, 'Game')).toBe(true);
      });
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

/**
 * Builds an in-memory subject whose `constructor.name` is `type`. `createForUser`
 * builds with a constructor-name `detectSubjectType`, which replaces CASL's default
 * and therefore bypasses the `subject()` tag — so instance-level `can()` checks must
 * carry the type on the constructor, exactly as a real entity would.
 */
function asEntity(type: string, props: Record<string, unknown>): Subjects {
  const Ctor = { [type]: class {} }[type];
  return Object.assign(new Ctor(), props) as unknown as Subjects;
}

function makeUser(overrides: Partial<UserWithRoles> = {}): UserWithRoles {
  return {
    id: 'user-1',
    roles: [],
    householdMember: [],
    eventsAttended: [],
    permissions: [],
    ...overrides,
  };
}

function makePermission(overrides: Partial<Permission> = {}): Permission {
  return {
    id: `perm-${Math.random()}`,
    action: Action.read,
    subject: 'Household',
    fields: [],
    conditions: {},
    inverted: false,
    reason: null,
    slug: `slug-${Math.random()}`,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeRole(name: string, permissions: Permission[]): RoleWithPermissions {
  return { role: { name, permissions: permissions.map((permission) => ({ permission })) } };
}

function makeUserPermission(
  overrides: Partial<Omit<UserPermissionWithPermission, 'permission'>> & {
    permission?: Partial<UserPermissionWithPermission['permission']>;
  } = {},
): UserPermissionWithPermission {
  const { permission, ...rest } = overrides;
  return {
    inverted: null,
    resourceType: ResourceType.Household,
    resourceId: null,
    expiresAt: null,
    permission: {
      action: Action.read,
      subject: 'Household',
      conditions: {},
      fields: [],
      inverted: false,
      ...permission,
    },
    ...rest,
  };
}
