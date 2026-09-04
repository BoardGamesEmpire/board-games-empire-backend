import { Action, ResourceType, RiskLevel, SystemRole } from '../client';
import {
  findTemplateDefects,
  findUnconditionedScopedGrants,
  findUnrenderableTemplateGrants,
  parseTemplate,
} from './catalog-guards';
import { KNOWN_TEMPLATE_VARIABLES } from './role.catalog';
import type { PermissionSeedDefinition, RoleScope } from './seed-definitions';

const definition = (overrides: Partial<PermissionSeedDefinition> & Pick<PermissionSeedDefinition, 'slug'>) =>
  ({
    action: Action.read,
    subject: ResourceType.Game,
    riskLevel: RiskLevel.Low,
    reason: 'fixture',
    ...overrides,
  }) satisfies PermissionSeedDefinition;

// A deliberately partial scope map: the guards take the map as an argument so
// the fixtures can classify only the roles they use.
const SCOPE: Readonly<Record<string, RoleScope>> = {
  [SystemRole.User]: 'global',
  [SystemRole.Moderator]: 'global',
  [SystemRole.HouseholdMember]: 'household',
  [SystemRole.EventGuest]: 'event',
};

describe('catalog guards', () => {
  describe('parseTemplate', () => {
    it('lists every variable the conditions interpolate, once each, in order of first use', () => {
      const conditions = {
        id: '{{ eventId }}',
        attendees: { some: { userId: '{{ user.id }}', again: '{{ eventId }}' } },
      };

      expect(parseTemplate(conditions)).toEqual({ variables: ['eventId', 'user.id'], problems: [] });
    });

    it('finds nothing to render in static or absent conditions', () => {
      const nothing = { variables: [], problems: [] };

      expect(parseTemplate({ deletedAt: null, visibility: { in: ['Public', 'Friends'] } })).toEqual(nothing);
      expect(parseTemplate(undefined)).toEqual(nothing);
      expect(parseTemplate({})).toEqual(nothing);
    });

    it('counts a section opener as a variable and walks its body', () => {
      expect(parseTemplate({ id: '{{#unit}}{{ unit.userId }}{{/unit}}' })).toEqual({
        variables: ['unit', 'unit.userId'],
        problems: [],
      });
    });

    it('reports a token type the factory refuses to render, and still lists the variables around it', () => {
      expect(parseTemplate({ id: '{{> shared }}', ok: '{{ eventId }}' })).toEqual({
        variables: ['eventId'],
        problems: [{ kind: 'unsupported-token-type', tokenType: '>' }],
      });
      expect(parseTemplate({ id: '{{! a note }}' }).problems).toEqual([
        { kind: 'unsupported-token-type', tokenType: '!' },
      ]);
      expect(parseTemplate({ id: '{{=<% %>=}}<% eventId %>' })).toEqual({
        variables: ['eventId'],
        problems: [{ kind: 'unsupported-token-type', tokenType: '=' }],
      });
    });

    it('reports a template that does not parse as a problem rather than an exception', () => {
      expect(parseTemplate({ id: '{{ unclosed' })).toEqual({
        variables: [],
        problems: [{ kind: 'malformed-template', message: expect.stringMatching(/Unclosed tag/) }],
      });
    });
  });

  describe('findUnconditionedScopedGrants', () => {
    const catalog = [
      definition({ slug: 'read:widget' }),
      definition({ slug: 'read:gadget' }),
      definition({ slug: 'read:audit' }),
      definition({ slug: 'read:member', conditions: { householdId: '{{ householdId }}' } }),
      definition({ slug: 'read:public', conditions: { visibility: 'Public' } }),
      definition({ slug: 'read:broken', conditions: { id: '{{ unclosed' } }),
    ];

    it('flags each scoped role holding an unconditioned permission the everyone role does not', () => {
      const roles = {
        [SystemRole.User]: [],
        [SystemRole.HouseholdMember]: ['read:widget', 'read:member'],
        [SystemRole.EventGuest]: ['read:widget'],
      };

      expect(findUnconditionedScopedGrants(catalog, roles, SCOPE, SystemRole.User)).toEqual([
        { slug: 'read:widget', role: SystemRole.HouseholdMember, scope: 'household' },
        { slug: 'read:widget', role: SystemRole.EventGuest, scope: 'event' },
      ]);
    });

    it('treats a static row filter as unconditioned — it narrows the rows, not who reaches them', () => {
      const roles = { [SystemRole.User]: [], [SystemRole.EventGuest]: ['read:public'] };

      expect(findUnconditionedScopedGrants(catalog, roles, SCOPE, SystemRole.User)).toEqual([
        { slug: 'read:public', role: SystemRole.EventGuest, scope: 'event' },
      ]);
    });

    it('passes an unconditioned permission the everyone role also holds — global reach is intended', () => {
      const roles = { [SystemRole.User]: ['read:gadget'], [SystemRole.HouseholdMember]: ['read:gadget'] };

      expect(findUnconditionedScopedGrants(catalog, roles, SCOPE, SystemRole.User)).toEqual([]);
    });

    it('passes an unconditioned permission only global roles hold', () => {
      const roles = { [SystemRole.User]: [], [SystemRole.Moderator]: ['read:audit'] };

      expect(findUnconditionedScopedGrants(catalog, roles, SCOPE, SystemRole.User)).toEqual([]);
    });

    it('passes a templated permission on a scoped role — the template is what binds it', () => {
      const roles = { [SystemRole.User]: [], [SystemRole.HouseholdMember]: ['read:member'] };

      expect(findUnconditionedScopedGrants(catalog, roles, SCOPE, SystemRole.User)).toEqual([]);
    });

    it('leaves a template that does not parse to the template guard', () => {
      const roles = { [SystemRole.User]: [], [SystemRole.EventGuest]: ['read:broken'] };

      expect(findUnconditionedScopedGrants(catalog, roles, SCOPE, SystemRole.User)).toEqual([]);
    });

    it('names a role the scope map does not classify, even one holding only grants it would skip', () => {
      const roles = { Wizard: ['read:member'] };

      expect(() => findUnconditionedScopedGrants(catalog, roles, SCOPE, SystemRole.User)).toThrow(/Wizard/);
    });

    it('counts a role once however many times it lists the slug', () => {
      const roles = { [SystemRole.User]: [], [SystemRole.EventGuest]: ['read:widget', 'read:widget'] };

      expect(findUnconditionedScopedGrants(catalog, roles, SCOPE, SystemRole.User)).toEqual([
        { slug: 'read:widget', role: SystemRole.EventGuest, scope: 'event' },
      ]);
    });
  });

  describe('findUnrenderableTemplateGrants', () => {
    const catalog = [
      definition({ slug: 'update:thing', conditions: { id: '{{ eventId }}', createdById: '{{ user.id }}' } }),
      definition({ slug: 'read:thing', conditions: { householdId: '{{ householdId }}' } }),
      definition({ slug: 'read:mine', conditions: { userId: '{{ user.email }}' } }),
      definition({ slug: 'read:anything' }),
      definition({ slug: 'read:occurrence', conditions: { occurrenceId: '{{ occurrenceId }}' } }),
      definition({ slug: 'read:broken', conditions: { id: '{{ eventId }}', other: '{{> shared }}' } }),
    ];
    // Deliberately NOT the shipped map: this event pass also supplies an
    // `occurrenceId`, so one case can show the guard consults the map it is
    // given rather than the one the catalog ships.
    const contexts: Readonly<Record<RoleScope, readonly string[]>> = {
      global: ['user.id', 'user.email', 'role'],
      household: ['user.id', 'user.email', 'role', 'householdId'],
      event: ['user.id', 'user.email', 'role', 'eventId', 'occurrenceId'],
    };

    it('names the slug, the role, its scope and the variables that scope never supplies', () => {
      const roles = { [SystemRole.HouseholdMember]: ['update:thing'], [SystemRole.Moderator]: ['read:thing'] };

      expect(findUnrenderableTemplateGrants(catalog, roles, SCOPE, contexts)).toEqual([
        { slug: 'update:thing', role: SystemRole.HouseholdMember, scope: 'household', variables: ['eventId'] },
        { slug: 'read:thing', role: SystemRole.Moderator, scope: 'global', variables: ['householdId'] },
      ]);
    });

    it('passes an edge whose every variable the pass supplies', () => {
      const roles = {
        [SystemRole.EventGuest]: ['update:thing'],
        [SystemRole.HouseholdMember]: ['read:thing'],
        [SystemRole.Moderator]: ['read:mine'],
      };

      expect(findUnrenderableTemplateGrants(catalog, roles, SCOPE, contexts)).toEqual([]);
    });

    it('passes an unconditioned grant — there is nothing to render', () => {
      const roles = { [SystemRole.HouseholdMember]: ['read:anything'] };

      expect(findUnrenderableTemplateGrants(catalog, roles, SCOPE, contexts)).toEqual([]);
    });

    it('judges each edge by the map it is given, not the shipped one', () => {
      const roles = { [SystemRole.EventGuest]: ['read:occurrence'], [SystemRole.HouseholdMember]: ['read:occurrence'] };

      expect(findUnrenderableTemplateGrants(catalog, roles, SCOPE, contexts)).toEqual([
        { slug: 'read:occurrence', role: SystemRole.HouseholdMember, scope: 'household', variables: ['occurrenceId'] },
      ]);
    });

    it('leaves a template with a problem to the template guard', () => {
      const roles = { [SystemRole.HouseholdMember]: ['read:broken'] };

      expect(findUnrenderableTemplateGrants(catalog, roles, SCOPE, contexts)).toEqual([]);
    });

    it('names a role the scope map does not classify, even one holding only grants it would skip', () => {
      const roles = { Wizard: ['read:anything'] };

      expect(() => findUnrenderableTemplateGrants(catalog, roles, SCOPE, contexts)).toThrow(/Wizard/);
    });
  });

  describe('findTemplateDefects', () => {
    it('names the slug and the variable the known set lacks', () => {
      const catalog = [definition({ slug: 'read:thing', conditions: { id: '{{ eventID }}', ok: '{{ eventId }}' } })];

      expect(findTemplateDefects(catalog, ['eventId'])).toEqual([
        { slug: 'read:thing', kind: 'unknown-variable', variable: 'eventID' },
      ]);
    });

    it('carries a template problem through under its slug', () => {
      const catalog = [
        definition({ slug: 'read:shared', conditions: { id: '{{> shared }}' } }),
        definition({ slug: 'read:broken', conditions: { id: '{{ unclosed' } }),
      ];

      expect(findTemplateDefects(catalog, [])).toEqual([
        { slug: 'read:shared', kind: 'unsupported-token-type', tokenType: '>' },
        { slug: 'read:broken', kind: 'malformed-template', message: expect.stringMatching(/Unclosed tag/) },
      ]);
    });

    it('the shipped known set accepts every role-pass variable and every plugin-context coordinate', () => {
      const catalog = [
        definition({
          slug: 'read:thing',
          conditions: {
            a: '{{ user.id }}',
            b: '{{ user.email }}',
            c: '{{ role }}',
            d: '{{ householdId }}',
            e: '{{ eventId }}',
            f: '{{ plugin.id }}',
            g: '{{ plugin.slug }}',
            h: '{{ unit.scopeType }}',
            i: '{{ unit.householdId }}',
            j: '{{ unit.userId }}',
          },
        }),
      ];

      expect(findTemplateDefects(catalog, KNOWN_TEMPLATE_VARIABLES)).toEqual([]);
    });

    it('the shipped known set rejects a bare object, a relation, a sub-path of a scalar and a column User lacks', () => {
      const catalog = [
        definition({
          slug: 'read:thing',
          conditions: { a: '{{ unit }}', b: '{{ user.roles }}', c: '{{ role.name }}', d: '{{ user.householdId }}' },
        }),
      ];

      expect(findTemplateDefects(catalog, KNOWN_TEMPLATE_VARIABLES)).toEqual([
        { slug: 'read:thing', kind: 'unknown-variable', variable: 'unit' },
        { slug: 'read:thing', kind: 'unknown-variable', variable: 'user.roles' },
        { slug: 'read:thing', kind: 'unknown-variable', variable: 'role.name' },
        { slug: 'read:thing', kind: 'unknown-variable', variable: 'user.householdId' },
      ]);
    });
  });
});
