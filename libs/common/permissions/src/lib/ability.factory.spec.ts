import type { Permission, PermissionSeedDefinition, PermissionSlug, RoleScope } from '@bge/database';
import {
  Action,
  PERMISSION_CATALOG,
  PermissionOwner,
  RENDER_CONTEXT_VARIABLES,
  ResourceType,
  RiskLevel,
  ROLE_PERMISSION_CATALOG,
  SystemRole,
} from '@bge/database';
import { subject } from '@casl/ability';
import { accessibleBy } from '@casl/prisma';
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

  describe('render contexts (#234)', () => {
    // One permission templated on every variable a role pass could supply.
    // Which fields render non-empty is decided by the pass the role arrives
    // through, and `RENDER_CONTEXT_VARIABLES` in @bge/database is the catalog
    // guards' statement of exactly that. The literal expectations are the
    // independent truth about the factory; the final assertion in each case
    // pins the map to them, so a renamed or dropped context key fails here
    // before the guards go quietly wrong.
    const PROBE_FIELD_VARIABLES = { id: 'householdId', name: 'eventId', createdById: 'user.id', slug: 'role' } as const;
    type ProbeField = keyof typeof PROBE_FIELD_VARIABLES;

    // Every ROLE pass draws its permissions from a role-carrying collection
    // on `UserWithRoles`, so this literal — keyed by exactly those
    // collections, valued by the scope each renders — is what turns a new
    // role pass into a compile error: a new collection is a missing key here
    // until the map gains a scope for it and a case below renders through it.
    // Direct user permissions (`permissions`) carry no role and render
    // `{ user }` alone; they are outside the map by design, and outside this
    // pin for the same reason.
    type RoleCarrying = {
      [K in keyof UserWithRoles]: UserWithRoles[K] extends readonly { role: unknown }[] ? K : never;
    }[keyof UserWithRoles];
    const passes: Readonly<Record<RoleCarrying, RoleScope>> = {
      roles: 'global',
      householdMember: 'household',
      eventsAttended: 'event',
    };

    // `user` in every pass is the permission graph, not the User row, so the
    // user variables the map may declare are the graph's own scalar keys —
    // today only `id`. This literal, keyed by exactly the non-collection keys
    // of `UserWithRoles`, is a compile error the day the graph loads another
    // scalar, and the first case below holds the map to it: a `{{ user.email }}`
    // the graph does not load renders `''` in every pass and must stay unknown
    // to the guards, however real the column is.
    type UserScalar = {
      [K in keyof UserWithRoles]: UserWithRoles[K] extends readonly unknown[] ? never : K;
    }[keyof UserWithRoles];
    const userVariables: { readonly [K in UserScalar]: `user.${K}` } = { id: 'user.id' };

    const probe = () =>
      makePermission({
        subject: 'Event',
        conditions: {
          id: '{{ householdId }}',
          name: '{{ eventId }}',
          createdById: '{{ user.id }}',
          slug: '{{ role }}',
        },
      });

    const renderedThrough = (scope: RoleScope, user: UserWithRoles) => {
      const conditions = factory.createForUser(user).rules.at(-1)?.conditions as Record<ProbeField, string>;
      const rendered = (Object.keys(PROBE_FIELD_VARIABLES) as ProbeField[])
        .filter((field) => conditions[field] !== '')
        .map((field) => PROBE_FIELD_VARIABLES[field])
        .sort();
      const declared = Object.values(PROBE_FIELD_VARIABLES)
        .filter((variable) => RENDER_CONTEXT_VARIABLES[scope].includes(variable))
        .sort();

      return { conditions, rendered, declared };
    };

    it('declares exactly the user fields the permission graph loads, in every pass', () => {
      for (const scope of Object.keys(RENDER_CONTEXT_VARIABLES) as RoleScope[]) {
        const declared = RENDER_CONTEXT_VARIABLES[scope].filter((variable) => variable.startsWith('user.'));

        expect(declared).toEqual(Object.values(userVariables));
      }
    });

    it('renders a global role with user and role only', () => {
      const user = makeUser({ id: 'user-1', roles: [makeRole('Moderator', [probe()])] });
      const { conditions, rendered, declared } = renderedThrough(passes.roles, user);

      expect(conditions).toEqual({ id: '', name: '', createdById: 'user-1', slug: 'Moderator' });
      expect(declared).toEqual(rendered);
    });

    it('renders a household role with householdId added', () => {
      const user = makeUser({
        id: 'user-1',
        householdMember: [{ householdId: 'hh-1', role: makeRole('HouseholdMember', [probe()]) }],
      });
      const { conditions, rendered, declared } = renderedThrough(passes.householdMember, user);

      expect(conditions).toEqual({ id: 'hh-1', name: '', createdById: 'user-1', slug: 'HouseholdMember' });
      expect(declared).toEqual(rendered);
    });

    it('renders an event role with eventId added', () => {
      const user = makeUser({
        id: 'user-1',
        eventsAttended: [{ eventId: 'ev-1', role: makeRole('EventGuest', [probe()]) }],
      });
      const { conditions, rendered, declared } = renderedThrough(passes.eventsAttended, user);

      expect(conditions).toEqual({ id: '', name: 'ev-1', createdById: 'user-1', slug: 'EventGuest' });
      expect(declared).toEqual(rendered);
    });
  });

  describe('household member rules (#155)', () => {
    // The fixtures are the REAL catalog entries, so a change to a seeded
    // condition is a change to what these specs render (#233 closed the
    // drift gap the hand-kept mirror left open). The expectations below stay
    // literal on purpose: they are the independent statement of what the
    // catalog must say.
    const readHouseholdMember = () => catalogPermission('read:household_member');
    const readHouseholdMemberFriends = () => catalogPermission('read:household_member:friends');
    const manageHouseholdMember = () => catalogPermission('manage:household_member');

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

      it("detects a subject()-TAGGED plain object by its tag — the #322 edge instance checks' shape", () => {
        // A plain object's constructor is `Object`, which matches no rule:
        // without tag-aware detection this check would silently deny for
        // members and non-members alike, which is exactly the wrong kind of
        // safe. The tag routes it to the same conditioned rules the
        // class-instance checks above evaluate.
        const ability = factory.createForUser(memberOf('HouseholdMember', ['hh-1']));

        expect(
          ability.can(Action.read, subject('HouseholdMember', { householdId: 'hh-1' }) as unknown as Subjects),
        ).toBe(true);
        expect(
          ability.can(Action.read, subject('HouseholdMember', { householdId: 'hh-2' }) as unknown as Subjects),
        ).toBe(false);
        // Untagged plain objects keep their previous meaning (constructor
        // detection → `Object`, no rule, denied) rather than throwing.
        expect(ability.can(Action.read, { householdId: 'hh-1' } as unknown as Subjects)).toBe(false);
      });

      it('keeps the pre-tag-aware failure mode for degenerate subjects — CASL’s typed refusal, never a TypeError', () => {
        const ability = factory.createForUser(memberOf('HouseholdMember', ['hh-1']));

        // CASL's own detectSubjectType dereferences `constructor` unguarded,
        // so routing a null-prototype object (prototype-stripped parser
        // output) through it would die with "Cannot read properties of
        // undefined". The guard falls back to the original passthrough,
        // which CASL's rule index refuses with ITS typed error — exactly
        // what the constructor-name detector produced before this change.
        const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, { householdId: 'hh-1' });
        expect(() => ability.can(Action.read, nullProto as unknown as Subjects)).toThrow(/subject types/);

        // Same story for an own `constructor: null` — CASL would die reading
        // `null.modelName`, so the guard must treat null and undefined alike.
        const shadowedCtor = { constructor: null, householdId: 'hh-1' };
        expect(() => ability.can(Action.read, shadowedCtor as unknown as Subjects)).toThrow(/subject types/);
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

  describe('scoped event grants (#432, #436)', () => {
    // Real catalog entries again. An event role renders through the event
    // pass and binds on `{{ eventId }}`; a household role renders through the
    // household pass and must bind on `{{ householdId }}`. Before #432 the
    // event-bound entries below carried no conditions, so every holder read
    // the whole install; before #436 the household roles held the event-bound
    // entries and could never match a row.
    const householdMemberOf = (householdId: string, roleName: string, slugs: PermissionSlug[]) =>
      makeUser({
        id: 'user-1',
        householdMember: [{ householdId, role: makeRole(roleName, slugs.map(catalogPermission)) }],
      });
    const eventGuestAt = (eventId: string, slugs: PermissionSlug[]) =>
      makeUser({
        id: 'user-1',
        eventsAttended: [{ eventId, role: makeRole('EventGuest', slugs.map(catalogPermission)) }],
      });

    it("bounds a household member's occurrence reads to the household's events — a clause, not {} (#432)", () => {
      // The whole shipped HouseholdMember role, composed: the ceiling is what
      // every grant the role carries unions to, not what one entry says.
      const ability = factory.createForUser(
        householdMemberOf('hh-1', 'HouseholdMember', [...ROLE_PERMISSION_CATALOG[SystemRole.HouseholdMember]]),
      );

      expect(accessibleBy(ability, Action.read).ofType('EventOccurrence')).toEqual({
        OR: [{ event: { is: { householdId: 'hh-1' } } }],
      });
      expect(
        ability.can(Action.read, asEntity('EventOccurrence', { eventId: 'ev-1', event: { householdId: 'hh-1' } })),
      ).toBe(true);
      expect(
        ability.can(Action.read, asEntity('EventOccurrence', { eventId: 'ev-2', event: { householdId: 'hh-2' } })),
      ).toBe(false);
      expect(
        ability.can(Action.read, asEntity('EventOccurrence', { eventId: 'ev-3', event: { householdId: null } })),
      ).toBe(false);
    });

    it("bounds an event guest's occurrence reads to the event attended", () => {
      const ability = factory.createForUser(eventGuestAt('ev-1', ['read:event_occurrence']));

      expect(accessibleBy(ability, Action.read).ofType('EventOccurrence')).toEqual({ OR: [{ eventId: 'ev-1' }] });
      expect(ability.can(Action.read, asEntity('EventOccurrence', { eventId: 'ev-1' }))).toBe(true);
      expect(ability.can(Action.read, asEntity('EventOccurrence', { eventId: 'ev-2' }))).toBe(false);
    });

    it("lets a household owner update the household's own events and no other (#436)", () => {
      const ability = factory.createForUser(householdMemberOf('hh-1', 'HouseholdOwner', ['update:event:household']));

      expect(ability.can(Action.update, asEntity('Event', { id: 'ev-1', householdId: 'hh-1' }))).toBe(true);
      expect(ability.can(Action.update, asEntity('Event', { id: 'ev-2', householdId: 'hh-2' }))).toBe(false);
      expect(ability.can(Action.update, asEntity('Event', { id: 'ev-3', householdId: null }))).toBe(false);
    });

    it.each([SystemRole.HouseholdOwner, SystemRole.HouseholdAdmin])(
      "lets a %s read the household's own events without attending them (#436)",
      (roleName) => {
        // The whole composed role. Neither held any Event read before, so an
        // owner could update a household event and manage its attendees but
        // never read the row itself.
        const ability = factory.createForUser(
          householdMemberOf('hh-1', roleName, [...ROLE_PERMISSION_CATALOG[roleName]]),
        );

        expect(accessibleBy(ability, Action.read).ofType('Event')).toEqual({ OR: [{ householdId: 'hh-1' }] });
        expect(ability.can(Action.read, asEntity('Event', { id: 'ev-1', householdId: 'hh-1' }))).toBe(true);
        expect(ability.can(Action.read, asEntity('Event', { id: 'ev-2', householdId: 'hh-2' }))).toBe(false);
        expect(ability.can(Action.read, asEntity('Event', { id: 'ev-3', householdId: null }))).toBe(false);
      },
    );

    it.each([SystemRole.EventParticipant, SystemRole.EventHost])(
      "limits a %s's own game-list writes to the event that granted the role (#432)",
      (roleName) => {
        // The whole composed role, rendered through one attendance. The
        // own-list pair used to name only the user, so a role held in one
        // event passed the game-list create check for the actor's own
        // attendee row in any other event; the manage grant already named
        // its event.
        const ability = factory.createForUser(
          makeUser({
            id: 'user-1',
            eventsAttended: [
              {
                eventId: 'ev-1',
                role: makeRole(roleName, [...ROLE_PERMISSION_CATALOG[roleName]].map(catalogPermission)),
              },
            ],
          }),
        );
        const ownEntry = (eventId: string) =>
          asEntity('EventAttendeeGameList', {
            attendeeId: 'a-1',
            attendee: { id: 'a-1', userId: 'user-1', eventId, event: { householdId: null } },
          });

        expect(ability.can(Action.create, ownEntry('ev-1'))).toBe(true);
        expect(ability.can(Action.delete, ownEntry('ev-1'))).toBe(true);
        expect(ability.can(Action.create, ownEntry('ev-2'))).toBe(false);
        expect(ability.can(Action.delete, ownEntry('ev-2'))).toBe(false);
      },
    );

    it('answers a create for an occurrence of the attended event, and refuses one for another event', () => {
      // What the occurrence create path asks, with the subject it builds from
      // the path parameter and the parent event row.
      const ability = factory.createForUser(eventGuestAt('ev-1', ['create:event_occurrence']));

      expect(ability.can(Action.create, ResourceType.EventOccurrence)).toBe(true);
      expect(
        ability.can(
          Action.create,
          subject(ResourceType.EventOccurrence, { eventId: 'ev-1', event: { householdId: null } }),
        ),
      ).toBe(true);
      expect(
        ability.can(
          Action.create,
          subject(ResourceType.EventOccurrence, { eventId: 'ev-2', event: { householdId: null } }),
        ),
      ).toBe(false);
    });
  });

  describe('staff grants (#244)', () => {
    // The composed staff roles, rendered through the GLOBAL `roles` pass — the
    // one that supplies neither `householdId` nor `eventId`. Before #244 that
    // was the whole problem twice over: 77 of Admin's grants were templated on
    // a coordinate this pass never supplies, so they rendered to clauses
    // matching nothing, and `manage:content:moderate` — an unconditioned
    // `manage` on 'all' — made that irrelevant by granting everything anyway.
    // These assertions are on the composed role, because the ceiling is what
    // every grant the role carries unions to, not what one entry says.
    const staff = (roleName: SystemRole) =>
      factory.createForUser(
        makeUser({
          id: 'user-1',
          roles: [makeRole(roleName, [...ROLE_PERMISSION_CATALOG[roleName]].map(catalogPermission))],
        }),
      );

    it.each([SystemRole.Admin, SystemRole.Moderator])(
      'gives %s no wildcard write — `manage` on `all` is Owner alone',
      (roleName) => {
        const ability = staff(roleName);

        expect(ability.can(Action.manage, asEntity('Household', { id: 'hh-1' }))).toBe(false);
        expect(ability.can(Action.update, asEntity('UserProfile', { userId: 'someone-else' }))).toBe(false);
      },
    );

    it('lets an Admin administer a household it is no member of', () => {
      const ability = staff(SystemRole.Admin);

      // `{}` is the unfiltered clause: no household predicate at all, which is
      // the only shape that can reach a household the actor has no row in.
      expect(accessibleBy(ability, Action.manage).ofType('HouseholdMember')).toEqual({});
      expect(accessibleBy(ability, Action.delete).ofType('Household')).toEqual({});
    });

    it('withholds from an Admin what the floor does not name', () => {
      const ability = staff(SystemRole.Admin);

      // `update:household` was one of the 77 inert grants and is deliberately
      // not in the floor: staff may read a household's roster and soft-delete
      // the household, not edit it. A floor, not a mirror.
      expect(accessibleBy(ability, Action.update).ofType('Household')).toEqual({ OR: [] });

      // Ownership transfer is NOT staff authority, and this is the assertion
      // that keeps it out. A slug for it was seeded and then removed:
      // `transferOwnership` refuses any actor who is not an owning member, so
      // the grant passed the route gate and bought nothing but a widened gate.
      // Driven end-to-end in `apps/api-e2e/src/permissions/staff-grant-seeds.spec.ts`.
      expect(accessibleBy(ability, Action.update).ofType('HouseholdRole')).toEqual({ OR: [] });

      // Nor does it carry an ORDINARY ability. Voting is bound to the actor's
      // own attendee row, so it belongs to whatever event role they attend
      // under; `Admin` held it for a while, and all that bought was letting an
      // Admin attending as a spectator vote. `{ OR: [] }` is deny-all.
      expect(accessibleBy(ability, Action.create).ofType('EventGameVote')).toEqual({ OR: [] });
    });

    it('elevates an Admin by union with User, not by repeating it', () => {
      const composed = factory.createForUser(
        makeUser({
          id: 'user-1',
          roles: [SystemRole.User, SystemRole.Admin].map((roleName) =>
            makeRole(roleName, [...ROLE_PERMISSION_CATALOG[roleName]].map(catalogPermission)),
          ),
        }),
      );

      // Each role contributes what the other does not. `create:household` is
      // `User`'s, and the Admin list no longer repeats it; the household floor
      // is the Admin role's, and `User` has never had it. Composed, the actor
      // holds both — which is why removing the repetition changed no outcome,
      // and why `Admin` on its own is now a DOWNGRADE rather than an elevation.
      expect(composed.can(Action.create, asEntity('Household', {}))).toBe(true);
      expect(accessibleBy(composed, Action.delete).ofType('Household')).toEqual({});

      expect(staff(SystemRole.Admin).can(Action.create, asEntity('Household', {}))).toBe(false);
    });

    it('lets an ordinary User edit and delete the games it created, and no others', () => {
      // The one EXPANSION in #244's trim, and the only part of it a user can
      // observe. `update:game:own`/`delete:game:own` were `Admin`-only, where
      // `Admin`'s own unconditioned `update:game`/`delete:game` subsumed them —
      // so nobody could edit a game they had created. They are `User`'s now,
      // which is what the domain already assumed: an imported game is public
      // and server-owned, a user-created one may be private and is its
      // creator's to change.
      //
      // Asserted as the Prisma clause rather than a boolean because that is
      // what `game.service.ts` actually feeds its `where` — and because
      // `delete:game:own` reaches a HARD delete, so the narrowing to
      // `createdById` is the whole of what stops one user destroying another's
      // row.
      const user = factory.createForUser(
        makeUser({
          id: 'user-1',
          roles: [makeRole(SystemRole.User, [...ROLE_PERMISSION_CATALOG[SystemRole.User]].map(catalogPermission))],
        }),
      );

      for (const action of [Action.update, Action.delete]) {
        expect(accessibleBy(user, action).ofType('Game')).toEqual({ OR: [{ createdById: 'user-1' }] });
      }

      expect(user.can(Action.delete, asEntity('Game', { createdById: 'user-1' }))).toBe(true);
      expect(user.can(Action.delete, asEntity('Game', { createdById: 'someone-else' }))).toBe(false);
    });

    it('lets an ordinary User read the games it created and every Public one, and no others', () => {
      // The clause the game list, the by-id read and search all put in their
      // `where` (#472). Before, `read:game` carried no condition, so this was
      // `{}`: every signed-in user read every private game.
      const user = factory.createForUser(
        makeUser({
          id: 'user-1',
          roles: [makeRole(SystemRole.User, [...ROLE_PERMISSION_CATALOG[SystemRole.User]].map(catalogPermission))],
        }),
      );

      expect(accessibleBy(user, Action.read).ofType('Game')).toEqual({
        OR: [
          { deletedAt: null, visibility: 'Public' },
          { deletedAt: null, createdById: 'user-1' },
        ],
      });
    });

    it('gives a Moderator content removal without household administration', () => {
      const ability = staff(SystemRole.Moderator);

      expect(accessibleBy(ability, Action.delete).ofType('GamePlaySession')).toEqual({});
      expect(accessibleBy(ability, Action.delete).ofType('Household')).toEqual({ OR: [] });
      expect(accessibleBy(ability, Action.manage).ofType('HouseholdMember')).toEqual({ OR: [] });
    });

    it.each([SystemRole.Admin, SystemRole.Moderator])('reads every subject as %s, through one grant', (roleName) => {
      // `read:public_content` is a `read` on 'all', so staff reads are already
      // unfiltered and a `read:*:administer` slug would grant nothing. This is
      // pinned because the floor's shape depends on it: if this ever stops
      // being `{}`, the read variants have to be seeded.
      expect(accessibleBy(staff(roleName), Action.read).ofType('Household')).toEqual({});
      expect(accessibleBy(staff(roleName), Action.read).ofType('HouseholdMember')).toEqual({});
    });
  });

  describe('the AnonymousUser floor (#484)', () => {
    // The composed role an anonymous user holds INSTEAD of `User`, rendered
    // through the same global `roles` pass. Anyone can open an anonymous
    // session, so what this ability reaches is what the whole internet reaches.
    const anonymous = () =>
      factory.createForUser(
        makeUser({
          id: 'anon-1',
          roles: [
            makeRole(
              SystemRole.AnonymousUser,
              [...ROLE_PERMISSION_CATALOG[SystemRole.AnonymousUser]].map(catalogPermission),
            ),
          ],
        }),
      );

    it('reads the Public collection entries that are not tombstoned, and no other collection row', () => {
      expect(accessibleBy(anonymous(), Action.read).ofType('GameCollection')).toEqual({
        OR: [{ deletedAt: null, visibility: 'Public' }],
      });
    });

    it('writes nothing, and reads no other subject', () => {
      const ability = anonymous();

      for (const action of [Action.create, Action.update, Action.delete]) {
        expect(ability.can(action, 'GameCollection')).toBe(false);
      }

      for (const subjectType of ['Game', 'Household', 'Event', 'User', 'UserProfile'] as const) {
        expect(ability.can(Action.read, subjectType)).toBe(false);
      }
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

    // Real catalog entries, as in the #155 block above.
    const transferOwnership = () => catalogPermission('update:household_role:transfer-ownership');
    const updateHousehold = () => catalogPermission('update:household');

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

      it('is the ONLY update/manage grant on HouseholdRole in the whole catalog, which is what makes the gate owner-only', () => {
        // `can(update, HouseholdRole)` is the controller gate. It can only stay
        // owner-only while no other slug ANYWHERE grants update (or manage,
        // which implies it) on this subject.
        //
        // Read from PERMISSION_CATALOG, not from a fixture. The fixture version
        // of this test built an ability from one hand-made HouseholdOwner grant,
        // so it counted the rule it had just supplied and could not observe a
        // second grant arriving from another role — which is how
        // `update:household_role:transfer-ownership:administer` reached the
        // global Admin role with this test green and the comment on
        // `household-member.controller.ts` quietly false.
        const grants = PERMISSION_CATALOG.filter(
          (permission) =>
            permission.subject === ResourceType.HouseholdRole &&
            [Action.update, Action.manage].includes(permission.action as 'update' | 'manage'),
        ).map((permission) => permission.slug);

        expect(grants).toEqual(['update:household_role:transfer-ownership']);
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

    describe('serving predicate', () => {
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

    describe('core grants — unit-coordinate rendering', () => {
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

    describe('fail-loud out-of-context rejection', () => {
      it('rejects the user-centric seed templates — {{ user.id }} is not plugin-grantable', () => {
        const seeded = catalogPermission('read:game');
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

      it('renders the public game read, which names no actor — the game read a plugin can hold', () => {
        const ability = factory.createForPlugin(
          makeSnapshot({ corePermissions: [catalogPermission('read:game:public')] }),
        );

        expect(accessibleBy(ability, Action.read).ofType('Game')).toEqual({
          OR: [{ deletedAt: null, visibility: 'Public' }],
        });
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

      it.each<[string, string, string]>([
        ['a partial token — renders to empty string, never validated by the name walk', '{{> some-partial }}', '>'],
        ['a comment token — renders to empty string', '{{! why is this here }}', '!'],
        ['a delimiter change — reshapes parsing itself', '{{=<% %>=}}<% unit.householdId %>', '='],
      ])(
        'rejects %s as unsupported-token-type, not a phantom out-of-context variable',
        (_label, template, tokenType) => {
          const snapshot = makeSnapshot({
            corePermissions: [
              makePermission({ action: Action.read, subject: 'Game', conditions: { householdId: template } }),
            ],
          });

          expect(() => factory.createForPlugin(snapshot)).toThrow(PluginAbilityRenderRejectionError);
          expect(() => factory.createForPlugin(snapshot)).toThrow(
            expect.objectContaining({ reason: 'unsupported-token-type', tokenType }),
          );
        },
      );

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
          corePermissions: [makePermission({ action: Action.read, subject: 'Game', conditions: { x: '{{ unit }}' } })],
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
    managedBy: PermissionOwner.System,
    retiredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * A `Permission` row built from the shipped catalog entry for `slug`, so a
 * spec exercises the condition template that actually seeds rather than a
 * copy of it. Conditions go through a JSON round-trip only to turn the
 * readonly `Prisma.InputJsonObject` the catalog carries into the plain
 * `JsonValue` a `Permission` row does; the factory never mutates what it
 * renders.
 */
function catalogPermission(slug: PermissionSlug): Permission {
  const catalog: readonly PermissionSeedDefinition[] = PERMISSION_CATALOG;
  const entry = catalog.find((definition) => definition.slug === slug);
  if (!entry) {
    throw new Error(`PERMISSION_CATALOG has no entry for '${slug}'`);
  }

  return makePermission({
    action: entry.action,
    subject: entry.subject,
    slug: entry.slug,
    riskLevel: entry.riskLevel,
    reason: entry.reason,
    fields: [...(entry.fields ?? [])],
    conditions: JSON.parse(JSON.stringify(entry.conditions ?? {})),
  });
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
