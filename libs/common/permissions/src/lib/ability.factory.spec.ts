import { Action, Permission, ResourceType, RiskLevel } from '@bge/database';
import { subject } from '@casl/ability';
import { Test, TestingModule } from '@nestjs/testing';
import { AbilityFactory } from './ability.factory';
import { PluginAbilityRenderRejectionError } from './errors/plugin-ability-render-rejection.error';
import type {
  ApiKeyScopeWithPermission,
  ApikeyWithScopes,
  PluginGrantSnapshot,
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

  /**
   * Rendering + scoping guards for the household-member authorization rules
   * introduced/corrected in #155. These assert two distinct things:
   *
   * 1. Flat, single-model conditions (`read:household_member`) are checked with
   *    in-memory `can()` — reliable, because no relation traversal is involved.
   * 2. Relation-traversing conditions (`read:household_member:friends`, the
   *    corrected `manage:household_member`) are asserted STRUCTURALLY on the
   *    rendered rule. In-memory CASL checks against relation clauses silently
   *    pass/fail depending on whether the relation happens to be loaded, so an
   *    `expect(...can(...))` there would be a false signal; the real evaluation
   *    happens in Prisma via `accessibleBy`. What matters here is that the
   *    template renders and that the field paths are the ones Prisma will accept.
   */
  /**
   * Every string leaf in a rendered condition tree, for empty-value detection.
   * Shared by the #155 and #158 rule suites: Mustache renders an out-of-context
   * variable as an EMPTY STRING rather than leaving a `{{ … }}` marker, so a
   * marker scan cannot detect one — an empty leaf is the actual symptom.
   */
  function stringLeaves(value: unknown, acc: string[] = []): string[] {
    if (typeof value === 'string') {
      acc.push(value);
    } else if (Array.isArray(value)) {
      value.forEach((item) => stringLeaves(item, acc));
    } else if (value !== null && typeof value === 'object') {
      Object.values(value).forEach((item) => stringLeaves(item, acc));
    }

    return acc;
  }

  describe('household member rules (#155)', () => {
    // Mirrors the seeded relational clause meaning "this User node is an
    // accepted friend of the acting user".
    const ACCEPTED_FRIEND_OF_ACTING_USER = {
      OR: [
        { friendshipsRequested: { some: { addresseeId: '{{ user.id }}', status: 'Accepted' } } },
        { friendshipsReceived: { some: { requesterId: '{{ user.id }}', status: 'Accepted' } } },
      ],
    };

    const readHouseholdMember = () =>
      makePermission({
        action: Action.read,
        subject: ResourceType.HouseholdMember,
        slug: 'read:household_member',
        conditions: { householdId: '{{ householdId }}' },
      });

    const readHouseholdMemberFriends = () =>
      makePermission({
        action: Action.read,
        subject: ResourceType.HouseholdMember,
        slug: 'read:household_member:friends',
        conditions: {
          household: { visibility: 'Friends', members: { some: { user: ACCEPTED_FRIEND_OF_ACTING_USER } } },
        },
      });

    const manageHouseholdMember = () =>
      makePermission({
        action: Action.manage,
        subject: ResourceType.HouseholdMember,
        slug: 'manage:household_member',
        conditions: {
          householdId: '{{ householdId }}',
          household: {
            members: {
              some: {
                userId: '{{ user.id }}',
                role: { role: { name: { in: ['HouseholdOwner', 'HouseholdAdmin'] } } },
              },
            },
          },
        },
      });

    /** A user whose only authority comes from household memberships. */
    const memberOf = (roleName: string, householdIds: string[], permissions = [readHouseholdMember()]) =>
      makeUser({
        id: 'user-1',
        householdMember: householdIds.map((householdId) => ({
          householdId,
          role: makeRole(roleName, permissions),
        })),
      });

    describe('read:household_member — membership scoping', () => {
      it('renders {{ householdId }} from the membership context, not the user context', () => {
        const ability = factory.createForUser(memberOf('HouseholdMember', ['hh-1']));

        expect(ability.rules.at(-1)?.conditions).toEqual({ householdId: 'hh-1' });
      });

      it('permits reading a member row of a household the actor belongs to', () => {
        const ability = factory.createForUser(memberOf('HouseholdMember', ['hh-1']));

        expect(ability.can(Action.read, asEntity('HouseholdMember', { id: 'm-1', householdId: 'hh-1' }))).toBe(true);
      });

      it("denies reading another household's member rows (the #155 acceptance criterion)", () => {
        const ability = factory.createForUser(memberOf('HouseholdMember', ['hh-1']));

        expect(ability.can(Action.read, asEntity('HouseholdMember', { id: 'm-9', householdId: 'hh-2' }))).toBe(false);
      });

      it('denies every member row for a user with no household memberships', () => {
        const ability = factory.createForUser(makeUser({ id: 'stranger' }));

        expect(ability.can(Action.read, asEntity('HouseholdMember', { id: 'm-1', householdId: 'hh-1' }))).toBe(false);
      });

      it('emits one independently-scoped rule per membership (multi-household actor)', () => {
        const ability = factory.createForUser(memberOf('HouseholdMember', ['hh-1', 'hh-2']));

        expect(ability.rules).toHaveLength(2);
        expect(ability.can(Action.read, asEntity('HouseholdMember', { householdId: 'hh-1' }))).toBe(true);
        expect(ability.can(Action.read, asEntity('HouseholdMember', { householdId: 'hh-2' }))).toBe(true);
        expect(ability.can(Action.read, asEntity('HouseholdMember', { householdId: 'hh-3' }))).toBe(false);
      });

      it.each(['HouseholdOwner', 'HouseholdAdmin', 'HouseholdMember', 'HouseholdGuest'])(
        'scopes identically regardless of which household role carries the grant (%s)',
        (roleName) => {
          const ability = factory.createForUser(memberOf(roleName, ['hh-1']));

          expect(ability.can(Action.read, asEntity('HouseholdMember', { householdId: 'hh-1' }))).toBe(true);
          expect(ability.can(Action.read, asEntity('HouseholdMember', { householdId: 'hh-2' }))).toBe(false);
        },
      );

      it('does not leak the grant onto a different subject type', () => {
        const ability = factory.createForUser(memberOf('HouseholdMember', ['hh-1']));

        expect(ability.can(Action.read, asEntity('Household', { id: 'hh-1' }))).toBe(false);
      });
    });

    describe('read:household_member:friends — relation-scoped rendering', () => {
      it('renders the acting user id into both friendship directions', () => {
        // Assigned to the base User role, so it renders against the user-only
        // context — there is no membership to supply {{ householdId }}.
        const user = makeUser({ id: 'user-42', roles: [makeRole('User', [readHouseholdMemberFriends()])] });

        const ability = factory.createForUser(user);

        expect(ability.rules.at(-1)?.conditions).toEqual({
          household: {
            visibility: 'Friends',
            members: {
              some: {
                user: {
                  OR: [
                    { friendshipsRequested: { some: { addresseeId: 'user-42', status: 'Accepted' } } },
                    { friendshipsReceived: { some: { requesterId: 'user-42', status: 'Accepted' } } },
                  ],
                },
              },
            },
          },
        });
      });

      it('traverses to the household through the `household` relation, never a top-level field', () => {
        const user = makeUser({ id: 'user-42', roles: [makeRole('User', [readHouseholdMemberFriends()])] });

        const conditions = factory.createForUser(user).rules.at(-1)?.conditions;

        // HouseholdMember has no `visibility`/`members` of its own — those live
        // on Household. A regression to the flat shape would make Prisma throw.
        expect(conditions).toHaveProperty('household');
        expect(conditions).not.toHaveProperty('visibility');
        expect(conditions).not.toHaveProperty('members');
      });

      it('renders every template variable to a non-empty value', () => {
        const user = makeUser({ id: 'user-42', roles: [makeRole('User', [readHouseholdMemberFriends()])] });

        const conditions = factory.createForUser(user).rules.at(-1)?.conditions;

        // Mustache resolves an unknown variable to an EMPTY STRING rather than
        // leaving a `{{ … }}` marker behind, so scanning for markers cannot
        // detect an out-of-context variable. An empty string leaf is the actual
        // symptom: a rule referencing `{{ householdId }}` from a base-role
        // (user-only) context degrades silently into a match-nothing clause.
        // Fail-loud rendering is tracked in #234.
        expect(stringLeaves(conditions)).not.toContain('');
      });
    });

    describe('manage:household_member — corrected relation path', () => {
      it('scopes the role check through `household.members`, not a top-level `members` field', () => {
        const user = memberOf('HouseholdOwner', ['hh-1'], [manageHouseholdMember()]);

        const conditions = factory.createForUser(user).rules.at(-1)?.conditions;

        expect(conditions).toEqual({
          householdId: 'hh-1',
          household: {
            members: {
              some: {
                userId: 'user-1',
                role: { role: { name: { in: ['HouseholdOwner', 'HouseholdAdmin'] } } },
              },
            },
          },
        });
        // Guards the defect fixed in #155: `members` is not a HouseholdMember field.
        expect(conditions).not.toHaveProperty('members');
      });

      it('pins management authority to the granting household only', () => {
        const user = memberOf('HouseholdOwner', ['hh-1'], [manageHouseholdMember()]);

        const conditions = factory.createForUser(user).rules.at(-1)?.conditions;

        expect(conditions).toMatchObject({ householdId: 'hh-1' });
      });
    });
  });

  /**
   * The Owner-only gate for transfer-ownership (#158) and the tightened
   * `update:household` condition (#160). Both are relation-traversing, so they
   * are asserted STRUCTURALLY for the reason documented above; what matters is
   * that the templates render and that the field paths are ones Prisma accepts.
   */
  describe('ownership transfer rules (#158, #160)', () => {
    const OWNER_OR_ADMIN = { in: ['HouseholdOwner', 'HouseholdAdmin'] };

    const transferOwnership = () =>
      makePermission({
        action: Action.update,
        subject: ResourceType.HouseholdRole,
        slug: 'update:household_role:transfer-ownership',
        conditions: {
          householdMember: {
            household: {
              id: '{{ householdId }}',
              members: {
                some: { userId: '{{ user.id }}', role: { role: { name: 'HouseholdOwner' } } },
              },
            },
          },
        },
      });

    const updateHousehold = () =>
      makePermission({
        action: Action.update,
        subject: ResourceType.Household,
        slug: 'update:household',
        conditions: {
          id: '{{ householdId }}',
          members: { some: { userId: '{{ user.id }}', role: { role: { name: OWNER_OR_ADMIN } } } },
        },
      });

    const holder = (roleName: string, permissions: ReturnType<typeof makePermission>[]) =>
      makeUser({
        id: 'user-1',
        householdMember: [{ householdId: 'hh-1', role: makeRole(roleName, permissions) }],
      });

    describe('update:household_role:transfer-ownership', () => {
      it('reaches the household only through the member row, never a field HouseholdRole lacks', () => {
        const conditions = factory
          .createForUser(holder('HouseholdOwner', [transferOwnership()]))
          .rules.at(-1)?.conditions;

        expect(conditions).toEqual({
          householdMember: {
            household: {
              id: 'hh-1',
              members: { some: { userId: 'user-1', role: { role: { name: 'HouseholdOwner' } } } },
            },
          },
        });
        // HouseholdRole carries neither of these; the pre-#241 shape used both.
        expect(conditions).not.toHaveProperty('householdId');
        expect(conditions).not.toHaveProperty('members');
      });

      it('is the ONLY update/manage grant on HouseholdRole, which is what makes the gate owner-only', () => {
        // `can(update, HouseholdRole)` is the controller gate. It can only stay
        // owner-only while no other rule grants update (or manage, which implies
        // it) on this subject — the seed enforces that by excluding the slug from
        // the derived HouseholdAdmin list.
        const ability = factory.createForUser(holder('HouseholdOwner', [transferOwnership()]));

        const householdRoleRules = ability.rules.filter(
          (rule) =>
            rule.subject === ResourceType.HouseholdRole &&
            [Action.update, Action.manage].includes(rule.action as 'update' | 'manage'),
        );

        expect(householdRoleRules).toHaveLength(1);
      });

      it('does not confer the gate on an admin who holds no such grant', () => {
        // The seed's `disallowedHouseholdAdminPermissions` is what produces this;
        // asserted here because the derived Admin list gives no compile-time signal.
        const ability = factory.createForUser(holder('HouseholdAdmin', [updateHousehold()]));

        expect(ability.can(Action.update, asEntity('HouseholdRole', { id: 'hr-1' }))).toBe(false);
      });

      it('pins the grant to the household the owner role came from', () => {
        const user = makeUser({
          id: 'user-1',
          householdMember: [
            { householdId: 'hh-1', role: makeRole('HouseholdOwner', [transferOwnership()]) },
            { householdId: 'hh-2', role: makeRole('HouseholdMember', []) },
          ],
        });

        const rendered = factory
          .createForUser(user)
          .rules.filter((rule) => rule.subject === ResourceType.HouseholdRole)
          .map(
            (rule) =>
              (rule.conditions as { householdMember: { household: { id: string } } }).householdMember.household.id,
          );

        expect(rendered).toEqual(['hh-1']);
      });

      it('renders every template variable to a non-empty value', () => {
        const conditions = factory
          .createForUser(holder('HouseholdOwner', [transferOwnership()]))
          .rules.at(-1)?.conditions;

        // An empty leaf is the symptom of a variable rendered out of context — a
        // match-nothing clause rather than a visible failure (#234, #244).
        expect(stringLeaves(conditions)).not.toContain('');
      });
    });

    describe('update:household — tightened condition (#160)', () => {
      it('requires an owner/admin membership, not merely a membership', () => {
        const conditions = factory
          .createForUser(holder('HouseholdOwner', [updateHousehold()]))
          .rules.at(-1)?.conditions;

        expect(conditions).toEqual({
          id: 'hh-1',
          members: { some: { userId: 'user-1', role: { role: { name: OWNER_OR_ADMIN } } } },
        });
      });

      it('still admits admins, which is why the transfer gate cannot live on this subject', () => {
        // `accessibleBy` unions every rule for an (action, subject) pair, so a
        // narrower Household+update rule could not have restricted this to owners.
        const conditions = factory.createForUser(holder('HouseholdAdmin', [updateHousehold()])).rules.at(-1)
          ?.conditions as { members: { some: { role: { role: { name: { in: string[] } } } } } };

        expect(conditions.members.some.role.role.name.in).toContain('HouseholdAdmin');
      });
    });
  });

  describe('createDenyAll', () => {
    it('produces a no-rule ability that denies everything', () => {
      const denyAll = factory.createDenyAll();

      expect(denyAll.rules).toHaveLength(0);
      expect(denyAll.can(Action.read, 'Game')).toBe(false);
      expect(denyAll.can(Action.manage, 'all')).toBe(false);
    });
  });

  describe('createForPlugin (#60)', () => {
    const makeSnapshot = (overrides: Partial<PluginGrantSnapshot> = {}): PluginGrantSnapshot => ({
      plugin: { id: 'plugin-1', slug: 'demo-plugin' },
      unit: { scopeType: 'Household', householdId: 'hh-x' },
      servable: true,
      corePermissions: [],
      ownGrantSlugs: [],
      ...overrides,
    });

    describe('serving predicate (D60-2)', () => {
      it('produces a no-rule ability when the unit is not servable, regardless of grants', () => {
        const ability = factory.createForPlugin(
          makeSnapshot({
            servable: false,
            corePermissions: [makePermission({ action: Action.read, subject: 'Game', conditions: null })],
            ownGrantSlugs: ['plugin|demo-plugin|manage:digest'],
          }),
        );

        expect(ability.rules).toHaveLength(0);
        expect(ability.can(Action.read, 'Game')).toBe(false);
      });
    });

    describe('own-namespace grants', () => {
      it('builds a (verb, enveloped subject) rule parsed from the canonical slug', () => {
        const ability = factory.createForPlugin(makeSnapshot({ ownGrantSlugs: ['plugin|demo-plugin|manage:digest'] }));

        expect(ability.can(Action.manage, 'plugin|demo-plugin|digest' as Subjects)).toBe(true);
      });

      it('never grants outside the enveloped subject space', () => {
        const ability = factory.createForPlugin(makeSnapshot({ ownGrantSlugs: ['plugin|demo-plugin|manage:digest'] }));

        expect(ability.can(Action.manage, 'digest' as Subjects)).toBe(false);
        expect(ability.can(Action.manage, 'Household')).toBe(false);
      });

      it('rejects a grant row whose slug names another plugin’s namespace (corrupted state)', () => {
        const build = () =>
          factory.createForPlugin(makeSnapshot({ ownGrantSlugs: ['plugin|other-plugin|manage:digest'] }));

        expect(build).toThrow(PluginAbilityRenderRejectionError);
        expect(build).toThrow(
          expect.objectContaining({
            reason: 'foreign-namespace-slug',
            permissionSlug: 'plugin|other-plugin|manage:digest',
            pluginSlug: 'demo-plugin',
          }),
        );
      });

      it('rejects an enveloped-but-unparseable slug as the same typed corruption, never a raw RangeError', () => {
        const build = () => factory.createForPlugin(makeSnapshot({ ownGrantSlugs: ['plugin|demo-plugin'] }));

        expect(build).not.toThrow(RangeError);
        expect(build).toThrow(
          expect.objectContaining({ reason: 'malformed-slug', permissionSlug: 'plugin|demo-plugin' }),
        );
      });
    });

    describe('core grants — unit-coordinate rendering (D-U)', () => {
      const readGameInHousehold = () =>
        makePermission({
          action: Action.read,
          subject: 'Game',
          slug: 'read:game:household-unit',
          conditions: { householdId: '{{ unit.householdId }}' },
        });

      it('renders conditions against the operating unit — household X, not household Y', () => {
        const ability = factory.createForPlugin(makeSnapshot({ corePermissions: [readGameInHousehold()] }));

        // Structural assertion (see #155 note above): the rendered clause is
        // what Prisma evaluates; an in-memory can() on relation-shaped data
        // would be a false signal.
        expect(ability.rules.at(-1)?.conditions).toEqual({ householdId: 'hh-x' });
        expect(stringLeaves(ability.rules.at(-1)?.conditions)).not.toContain('');
      });

      it('exposes plugin identity to templates ({{ plugin.slug }} / {{ plugin.id }})', () => {
        const ability = factory.createForPlugin(
          makeSnapshot({
            corePermissions: [
              makePermission({
                action: Action.read,
                subject: 'Game',
                conditions: { source: '{{ plugin.slug }}' },
              }),
            ],
          }),
        );

        expect(ability.rules.at(-1)?.conditions).toEqual({ source: 'demo-plugin' });
      });

      it('honours inverted core permissions as cannot-rules', () => {
        const ability = factory.createForPlugin(
          makeSnapshot({
            corePermissions: [
              makePermission({ action: Action.read, subject: 'Game', conditions: null }),
              makePermission({ action: Action.read, subject: 'Game', inverted: true, conditions: null }),
            ],
          }),
        );

        expect(ability.can(Action.read, 'Game')).toBe(false);
      });

      it('honours condition-free permissions as type-level rules', () => {
        const ability = factory.createForPlugin(
          makeSnapshot({
            corePermissions: [makePermission({ action: Action.read, subject: 'Game', conditions: null })],
          }),
        );

        expect(ability.can(Action.read, 'Game')).toBe(true);
      });
    });

    describe('fail-loud out-of-context rejection (D60-3)', () => {
      it('rejects the user-centric seed templates — {{ user.id }} is not plugin-grantable', () => {
        const seeded = makePermission({
          action: Action.read,
          subject: 'Game',
          slug: 'read:game',
          conditions: { userId: '{{ user.id }}' },
        });
        const build = () => factory.createForPlugin(makeSnapshot({ corePermissions: [seeded] }));

        expect(build).toThrow(PluginAbilityRenderRejectionError);
        expect(build).toThrow(
          expect.objectContaining({
            reason: 'out-of-context-variable',
            variable: 'user.id',
            permissionSlug: 'read:game',
            unit: { scopeType: 'Household', householdId: 'hh-x' },
          }),
        );
      });

      it('rejects {{ unit.householdId }} while operating as a Server unit — the coordinate is absent, not empty', () => {
        const snapshot = makeSnapshot({
          unit: { scopeType: 'Server' },
          corePermissions: [
            makePermission({
              action: Action.read,
              subject: 'Game',
              conditions: { householdId: '{{ unit.householdId }}' },
            }),
          ],
        });

        expect(() => factory.createForPlugin(snapshot)).toThrow(PluginAbilityRenderRejectionError);
      });

      it.each<[string, string]>([
        ['a partial token — renders to empty string, never validated by the name walk', '{{> some-partial }}'],
        ['a comment token — renders to empty string', '{{! why is this here }}'],
      ])('rejects %s', (_label, template) => {
        const snapshot = makeSnapshot({
          corePermissions: [
            makePermission({ action: Action.read, subject: 'Game', conditions: { householdId: template } }),
          ],
        });

        expect(() => factory.createForPlugin(snapshot)).toThrow(PluginAbilityRenderRejectionError);
      });

      it('rejects prototype-chain paths — `in`-style lookup would admit {{ unit.constructor }}', () => {
        const snapshot = makeSnapshot({
          corePermissions: [
            makePermission({ action: Action.read, subject: 'Game', conditions: { x: '{{ unit.constructor }}' } }),
          ],
        });

        expect(() => factory.createForPlugin(snapshot)).toThrow(PluginAbilityRenderRejectionError);
      });

      it('rejects non-leaf resolutions — {{ unit }} would render [object Object] into the clause', () => {
        const snapshot = makeSnapshot({
          corePermissions: [
            makePermission({ action: Action.read, subject: 'Game', conditions: { x: '{{ unit }}' } }),
          ],
        });

        expect(() => factory.createForPlugin(snapshot)).toThrow(
          expect.objectContaining({ reason: 'out-of-context-variable', variable: 'unit' }),
        );
      });

      it('rejects a template that does not parse (unclosed tag) as a typed rejection, never Mustache’s raw Error', () => {
        const snapshot = makeSnapshot({
          corePermissions: [
            makePermission({
              action: Action.read,
              subject: 'Game',
              slug: 'read:game:broken',
              conditions: { householdId: '{{ unit.householdId' },
            }),
          ],
        });
        const build = () => factory.createForPlugin(snapshot);

        expect(build).toThrow(
          expect.objectContaining({ reason: 'malformed-template', permissionSlug: 'read:game:broken' }),
        );
      });

      it('rejects section variables outside the context, not only interpolations', () => {
        const snapshot = makeSnapshot({
          corePermissions: [
            makePermission({
              action: Action.read,
              subject: 'Game',
              conditions: { flag: '{{#user}}{{ user.id }}{{/user}}' },
            }),
          ],
        });

        expect(() => factory.createForPlugin(snapshot)).toThrow(PluginAbilityRenderRejectionError);
      });

      it('never renders a malformed clause — no empty string leaves can reach the rule set', () => {
        // The user ability path accepts silent out-of-context rendering; the
        // plugin path must never produce the `{ userId: '' }` shape at all.
        const ability = factory.createForPlugin(
          makeSnapshot({
            corePermissions: [
              makePermission({
                action: Action.read,
                subject: 'Game',
                conditions: { householdId: '{{ unit.householdId }}', via: '{{ unit.scopeType }}' },
              }),
            ],
          }),
        );

        for (const rule of ability.rules) {
          expect(stringLeaves(rule.conditions)).not.toContain('');
        }
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
    riskLevel: RiskLevel.Low,
    reason: null,
    slug: `slug-${Math.random()}`,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeRole(name: string, permissions: Permission[]): RoleWithPermissions {
  return {
    role: {
      name,
      permissions: permissions.map((permission) => ({ permission })),
    },
  };
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
