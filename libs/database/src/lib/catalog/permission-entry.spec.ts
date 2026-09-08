import { Action, ResourceType, RiskLevel } from '../client';
import { permission } from './permission-entry';
import { acceptedFriendOfActingUser, type PermissionSlug } from './permission.catalog';

// `permission()` is a compile-time guard: an entry's `conditions` and
// `fields` are checked against the Prisma types of its own `subject` while
// the file compiles. The `it` blocks below are therefore type tests: each
// negative is an `@ts-expect-error` that `database:typecheck` enforces (an
// unused directive is itself a compile error), and jest — which transpiles
// with SWC and checks nothing — only confirms they run. The one behaviour
// jest can observe is that the builder returns its argument. The positive
// case at scale is `permission.catalog.ts` itself: every shipped entry goes
// through the builder (#234).
const base = { action: Action.read, riskLevel: RiskLevel.Low, reason: 'fixture' } as const;

describe('permission()', () => {
  it('returns the entry it was given, unchanged', () => {
    const entry = { ...base, subject: ResourceType.Event, slug: 'read:fixture', conditions: { id: '{{ eventId }}' } };

    expect(permission(entry)).toBe(entry);
  });

  it('accepts paths, operators, static filters and fields that exist on the subject', () => {
    permission({
      ...base,
      subject: ResourceType.Event,
      slug: 'ok:relation-traversal',
      conditions: {
        id: '{{ eventId }}',
        status: 'Cancelled',
        attendees: {
          some: { userId: '{{ user.id }}', role: { role: { name: { in: ['EventHost', 'EventCoHost'] } } } },
        },
      },
    });
    permission({
      ...base,
      subject: ResourceType.GameCollection,
      slug: 'ok:null-and-shared-clause',
      conditions: { deletedAt: null, visibility: { in: ['Friends', 'Public'] }, user: acceptedFriendOfActingUser },
    });
    permission({ ...base, subject: ResourceType.EventAttendee, slug: 'ok:fields', fields: ['status', 'notes'] });
    permission({ ...base, subject: 'all', slug: 'ok:wildcard' });
  });

  it('rejects a field path the subject does not have', () => {
    permission({
      ...base,
      subject: ResourceType.HouseholdMember,
      slug: 'bad:unknown-relation',
      conditions: {
        // @ts-expect-error -- HouseholdMember has no `members`; the path runs through `household` (#155)
        members: { some: { userId: '{{ user.id }}' } },
      },
    });
    permission({
      ...base,
      subject: ResourceType.HouseholdRole,
      slug: 'bad:unknown-scalar',
      conditions: {
        // @ts-expect-error -- HouseholdRole has no `householdId`; the household is reached through `householdMember` (#156)
        householdId: '{{ householdId }}',
      },
    });
  });

  it('rejects a relation operator under a scalar', () => {
    permission({
      ...base,
      subject: ResourceType.Event,
      slug: 'bad:operator-under-scalar',
      conditions: {
        id: {
          // @ts-expect-error -- `id` is a scalar; `some` is a list-relation filter
          some: '{{ eventId }}',
        },
      },
    });
  });

  it('rejects a list operator under a to-one relation', () => {
    permission({
      ...base,
      subject: ResourceType.HouseholdMember,
      slug: 'bad:operator-position',
      conditions: {
        household: {
          // @ts-expect-error -- `household` is to-one, so `some` is not a filter here
          some: { id: '{{ householdId }}' },
        },
      },
    });
  });

  it('rejects a `fields` entry that is not a scalar on the subject', () => {
    permission({
      ...base,
      subject: ResourceType.EventAttendee,
      slug: 'bad:fields',
      fields: [
        'status',
        // @ts-expect-error -- not a column of EventAttendee
        'nope',
      ],
    });
  });

  it('rejects conditions on a subject with no model, and on the wildcard', () => {
    permission({
      ...base,
      subject: ResourceType.FeedbackSinkDispatch,
      slug: 'bad:no-model',
      // @ts-expect-error -- FeedbackSinkDispatch has no Prisma model to filter
      conditions: { id: 'x' },
    });
    permission({
      ...base,
      subject: 'all',
      slug: 'bad:wildcard',
      // @ts-expect-error -- the wildcard has no model to filter
      conditions: { id: 'x' },
    });
  });

  it('requires every member the seed definition requires', () => {
    // @ts-expect-error -- `riskLevel` is required at the type level (#60); the entry type is derived from PermissionSeedDefinition
    permission({ action: Action.read, subject: ResourceType.Event, slug: 'bad:unclassified', reason: 'fixture' });
  });

  it('returns a readonly definition', () => {
    const defined = permission({ ...base, subject: ResourceType.Event, slug: 'read:readonly' });

    // @ts-expect-error -- the seed, the guards and the reconciler all read the one catalog; none may change it
    defined.reason = 'mutated';
  });

  it('keeps PermissionSlug a literal union of the shipped slugs', () => {
    const shipped: PermissionSlug = 'manage:all';
    // @ts-expect-error -- not a slug the catalog defines
    const bogus: PermissionSlug = 'read:nothing';

    expect([shipped, bogus]).toHaveLength(2);
  });
});
