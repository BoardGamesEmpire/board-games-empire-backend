import type { Prisma } from '../client';
import { Action, PluginGrantScope, ResourceType, RiskLevel } from '../client';
import { hasBoundingConditions } from '../utils/permission-conditions';
import { parseTemplate } from './catalog-guards';
import { PERMISSION_CATALOG } from './permission.catalog';
import {
  bindsConsentUnit,
  isWildcardSubject,
  judgeConsentDecision,
  PLUGIN_UNIT_CONSENT_PUBLIC_READS,
  type PluginUnitGrantScope,
} from './plugin-consent-unit-binding';

const catalogEntry = (slug: string) => {
  const entry = PERMISSION_CATALOG.find((permission) => permission.slug === slug);

  if (!entry) {
    throw new Error(`'${slug}' is not in the permission catalog`);
  }

  return entry;
};

/** A row with the catalog's rule for `slug`, as the consent seams load it. */
const catalogRow = (slug: string) => {
  const entry = catalogEntry(slug);

  return {
    slug,
    action: entry.action,
    subject: entry.subject,
    fields: entry.fields ?? [],
    inverted: false,
    conditions: (entry.conditions ?? null) as Prisma.JsonValue,
  };
};

/** A row off the allowlist, judged by its subject and conditions alone. */
const ruleRow = (conditions: unknown, subject: string) => ({
  slug: 'test:slug',
  action: Action.read,
  subject,
  fields: [],
  inverted: false,
  conditions: conditions as Prisma.JsonValue,
});

const UNIT_SCOPES: readonly PluginUnitGrantScope[] = [PluginGrantScope.Household, PluginGrantScope.User];

describe('bindsConsentUnit (#591)', () => {
  // Each row sits on a real subject. A row refused for a structural reason
  // puts the id on a column that would otherwise bind it, so it tests only
  // its own reason (#994).
  it.each<[string, string, unknown, PluginUnitGrantScope, boolean]>([
    [
      "names the household's own id",
      ResourceType.Event,
      { householdId: '{{ unit.householdId }}' },
      PluginGrantScope.Household,
      true,
    ],
    [
      "names the user's own id",
      ResourceType.Household,
      { createdById: '{{ unit.userId }}' },
      PluginGrantScope.User,
      true,
    ],
    [
      'names the unit id beside the plugin id',
      ResourceType.Event,
      { householdId: '{{ unit.householdId }}', pluginId: '{{ plugin.id }}' },
      PluginGrantScope.Household,
      true,
    ],
    [
      "names the wrong unit's id at household scope",
      ResourceType.Event,
      { createdById: '{{ unit.userId }}' },
      PluginGrantScope.Household,
      false,
    ],
    [
      "names the wrong unit's id at user scope",
      ResourceType.Event,
      { householdId: '{{ unit.householdId }}' },
      PluginGrantScope.User,
      false,
    ],
    [
      'names a variable outside the plugin render context beside the unit id',
      ResourceType.Event,
      { householdId: '{{ unit.householdId }}', createdById: '{{ user.id }}' },
      PluginGrantScope.Household,
      false,
    ],
    [
      'names a role-pass variable',
      ResourceType.Event,
      { householdId: '{{ householdId }}' },
      PluginGrantScope.Household,
      false,
    ],
    ['names the acting user', ResourceType.GameCollection, { userId: '{{ user.id }}' }, PluginGrantScope.User, false],
    [
      'carries fixed conditions only',
      ResourceType.Household,
      { deletedAt: { not: null } },
      PluginGrantScope.Household,
      false,
    ],
    [
      'names the plugin but no unit id',
      ResourceType.Household,
      { pluginId: '{{ plugin.id }}' },
      PluginGrantScope.Household,
      false,
    ],
    ['carries no conditions (null)', ResourceType.Household, null, PluginGrantScope.Household, false],
    ['carries no conditions ({})', ResourceType.Household, {}, PluginGrantScope.Household, false],
    ['does not parse', ResourceType.Event, { householdId: '{{ unit.householdId }' }, PluginGrantScope.Household, false],
    // Where the id sits decides whether it binds: rows outside the unit must
    // not match.
    [
      'matches the id with equals',
      ResourceType.Event,
      { householdId: { equals: '{{ unit.householdId }}' } },
      PluginGrantScope.Household,
      true,
    ],
    [
      // Prisma sends equals beside insensitive mode as an unescaped ILIKE (#994).
      'matches the id with equals in insensitive mode',
      ResourceType.Event,
      { householdId: { equals: '{{ unit.householdId }}', mode: 'insensitive' } },
      PluginGrantScope.Household,
      false,
    ],
    [
      'matches the id through an is relation filter',
      ResourceType.Event,
      { household: { is: { id: '{{ unit.householdId }}' } } },
      PluginGrantScope.Household,
      true,
    ],
    [
      'matches the id through a some relation filter',
      ResourceType.Household,
      { members: { some: { userId: '{{ unit.userId }}' } } },
      PluginGrantScope.User,
      true,
    ],
    [
      'matches the id inside AND',
      ResourceType.Event,
      { AND: [{ deletedAt: null }, { householdId: '{{ unit.householdId }}' }] },
      PluginGrantScope.Household,
      true,
    ],
    [
      'matches the id beside an OR that narrows further',
      ResourceType.Event,
      { householdId: '{{ unit.householdId }}', OR: [{ reach: 'Public' }, { deletedAt: null }] },
      PluginGrantScope.Household,
      true,
    ],
    [
      'negates the id',
      ResourceType.Event,
      { householdId: { not: '{{ unit.householdId }}' } },
      PluginGrantScope.Household,
      false,
    ],
    [
      'negates the id under NOT',
      ResourceType.Event,
      { NOT: { householdId: '{{ unit.householdId }}' } },
      PluginGrantScope.Household,
      false,
    ],
    [
      'offers the id under OR beside a fixed branch',
      ResourceType.Event,
      { OR: [{ householdId: '{{ unit.householdId }}' }, { deletedAt: { not: null } }] },
      PluginGrantScope.Household,
      false,
    ],
    [
      'names the id only as a section',
      ResourceType.Event,
      { householdId: '{{#unit.householdId}}{{/unit.householdId}}' },
      PluginGrantScope.Household,
      false,
    ],
    // The factory renders the whole serialized object, so a section opened in
    // one field and closed in another removes the equality between them.
    [
      'wraps the id equality in a section spanning other values',
      ResourceType.Household,
      {
        name: { contains: '{{^unit.householdId}}' },
        id: '{{ unit.householdId }}',
        description: { contains: '{{/unit.householdId}}' },
      },
      PluginGrantScope.Household,
      false,
    ],
    [
      'wraps the id equality in a section spanning keys',
      ResourceType.Household,
      { '{{^unit.userId}}a': 1, createdById: '{{ unit.userId }}', 'b{{/unit.userId}}': 2 },
      PluginGrantScope.User,
      false,
    ],
    [
      'carries a section in another field beside the id equality',
      ResourceType.Event,
      { householdId: '{{ unit.householdId }}', name: '{{#plugin.slug}}x{{/plugin.slug}}' },
      PluginGrantScope.Household,
      false,
    ],
    // Keys render too, and JSON.parse keeps the last of two equal keys, so a
    // rendered key can replace the id equality or pick the field it binds.
    [
      'carries a templated key that renders over the id equality',
      ResourceType.Event,
      { householdId: '{{ unit.householdId }}', '{{ plugin.slug }}Id': 'hh-other' },
      PluginGrantScope.Household,
      false,
    ],
    [
      'carries a templated key inside the relation filter that binds the id',
      ResourceType.Event,
      { household: { is: { id: '{{ unit.householdId }}', '{{ plugin.slug }}': 'hh-other' } } },
      PluginGrantScope.Household,
      false,
    ],
    [
      'binds the id under a templated key',
      ResourceType.Event,
      { '{{ plugin.slug }}Id': '{{ unit.householdId }}' },
      PluginGrantScope.Household,
      false,
    ],
    [
      'embeds the id in surrounding text',
      ResourceType.Event,
      { householdId: 'prefix-{{ unit.householdId }}' },
      PluginGrantScope.Household,
      false,
    ],
    [
      'compares the id by range',
      ResourceType.Event,
      { householdId: { gte: '{{ unit.householdId }}' } },
      PluginGrantScope.Household,
      false,
    ],
    [
      'matches the id by substring',
      ResourceType.Event,
      { householdId: { contains: '{{ unit.householdId }}' } },
      PluginGrantScope.Household,
      false,
    ],
    [
      'excludes the id through isNot',
      ResourceType.Event,
      { household: { isNot: { id: '{{ unit.householdId }}' } } },
      PluginGrantScope.Household,
      false,
    ],
    [
      'requires the id of every related row, which no related row satisfies vacuously',
      ResourceType.Household,
      { members: { every: { userId: '{{ unit.userId }}' } } },
      PluginGrantScope.User,
      false,
    ],
    [
      'excludes the id through none',
      ResourceType.Household,
      { members: { none: { userId: '{{ unit.userId }}' } } },
      PluginGrantScope.User,
      false,
    ],
    // The id binds only on a column that holds that unit's id: a foreign key
    // to Household or User, or that model's own id, judged against the model
    // the filter is on. A text field set to the id would put any row with that
    // text inside the unit's consent (#994).
    [
      'puts the household id on a text field',
      ResourceType.Event,
      { title: '{{ unit.householdId }}' },
      PluginGrantScope.Household,
      false,
    ],
    [
      "puts the household id on another model's own id",
      ResourceType.Event,
      { id: '{{ unit.householdId }}' },
      PluginGrantScope.Household,
      false,
    ],
    [
      "names the household's own id on Household",
      ResourceType.Household,
      { id: '{{ unit.householdId }}' },
      PluginGrantScope.Household,
      true,
    ],
    ["names the user's own id on User", ResourceType.User, { id: '{{ unit.userId }}' }, PluginGrantScope.User, true],
    [
      "puts the user id on Household's own id",
      ResourceType.Household,
      { id: '{{ unit.userId }}' },
      PluginGrantScope.User,
      false,
    ],
    [
      'names the household id on a key that is also its foreign key',
      'HouseholdSettings',
      { householdId: '{{ unit.householdId }}' },
      PluginGrantScope.Household,
      true,
    ],
    [
      'puts the household id on a text field through is',
      ResourceType.Event,
      { household: { is: { name: '{{ unit.householdId }}' } } },
      PluginGrantScope.Household,
      false,
    ],
    [
      'puts the household id on a user-id column through is',
      ResourceType.Event,
      { household: { is: { createdById: '{{ unit.householdId }}' } } },
      PluginGrantScope.Household,
      false,
    ],
    [
      'names the user id on a user-id column through is',
      ResourceType.Event,
      { household: { is: { createdById: '{{ unit.userId }}' } } },
      PluginGrantScope.User,
      true,
    ],
    [
      'names the user id through two relation filters',
      ResourceType.Household,
      { members: { some: { user: { is: { id: '{{ unit.userId }}' } } } } },
      PluginGrantScope.User,
      true,
    ],
    [
      'puts the user id on a text field through two relation filters',
      ResourceType.Household,
      { members: { some: { user: { is: { username: '{{ unit.userId }}' } } } } },
      PluginGrantScope.User,
      false,
    ],
    [
      'filters a scalar column as if it were a relation',
      ResourceType.Event,
      { householdId: { is: { id: '{{ unit.householdId }}' } } },
      PluginGrantScope.Household,
      false,
    ],
    [
      'filters through a key Object.prototype holds',
      ResourceType.Event,
      { constructor: { is: { id: '{{ unit.householdId }}' } } },
      PluginGrantScope.Household,
      false,
    ],
    // A subject with no Prisma model has no id column at all.
    [
      'names a subject with no Prisma model',
      ResourceType.Campaign,
      { householdId: '{{ unit.householdId }}' },
      PluginGrantScope.Household,
      false,
    ],
    ['names the all subject', 'all', { householdId: '{{ unit.householdId }}' }, PluginGrantScope.Household, false],
    [
      'names a subject Object.prototype holds',
      'toString',
      { householdId: '{{ unit.householdId }}' },
      PluginGrantScope.Household,
      false,
    ],
  ])('%s', (_label, subject, conditions, scope, expected) => {
    expect(bindsConsentUnit(ruleRow(conditions, subject), scope)).toBe(expected);
  });

  it('admits every allowlisted public read at both unit scopes', () => {
    for (const slug of PLUGIN_UNIT_CONSENT_PUBLIC_READS) {
      for (const scope of UNIT_SCOPES) {
        expect({ slug, scope, binds: bindsConsentUnit(catalogRow(slug), scope) }).toEqual({
          slug,
          scope,
          binds: true,
        });
      }
    }
  });

  describe('an allowlisted public read whose row changed (#591)', () => {
    const slug = 'read:event:public';

    it('refuses one that gained a variable outside the plugin render context, for that permission alone', () => {
      // The factory would refuse the whole plugin ability over this row, so
      // consent to it must fail here instead.
      const conditions = { ...(catalogEntry(slug).conditions as object), createdById: '{{ user.id }}' };

      expect(bindsConsentUnit({ ...catalogRow(slug), conditions }, PluginGrantScope.Household)).toBe(false);
    });

    it('admits one that gained a clause binding the consenting unit', () => {
      const conditions = { ...(catalogEntry(slug).conditions as object), householdId: '{{ unit.householdId }}' };

      expect(bindsConsentUnit({ ...catalogRow(slug), conditions }, PluginGrantScope.Household)).toBe(true);
    });

    it.each([null, {}])('refuses one that lost its conditions (%p): it would read every row', (conditions) => {
      expect(bindsConsentUnit({ ...catalogRow(slug), conditions }, PluginGrantScope.Household)).toBe(false);
    });

    // An Admin-owned row keeps its drift, and the plugin ability applies the
    // row as stored, so the slug alone does not make it a public read.
    it.each<[string, Partial<ReturnType<typeof catalogRow>>]>([
      ['a write action', { action: Action.delete }],
      ['another subject', { subject: ResourceType.Household }],
      ['a field restriction', { fields: ['name'] }],
      ['an inversion', { inverted: true }],
      ['other fixed conditions', { conditions: { deletedAt: { not: null } } }],
    ])('refuses one that drifted to %s', (_label, drift) => {
      for (const scope of UNIT_SCOPES) {
        expect({ scope, binds: bindsConsentUnit({ ...catalogRow(slug), ...drift }, scope) }).toEqual({
          scope,
          binds: false,
        });
      }
    });
  });

  it('refuses the three fixed-condition slugs left off the allowlist', () => {
    for (const slug of ['update:household:restore', 'update:household:restore:administer', 'create:event']) {
      for (const scope of UNIT_SCOPES) {
        expect({ slug, scope, binds: bindsConsentUnit(catalogRow(slug), scope) }).toEqual({
          slug,
          scope,
          binds: false,
        });
      }
    }
  });

  it('pins the allowlist to fixed-condition reads in the catalog', () => {
    // An addition is a reviewed change: each entry widens what a single
    // unit's consent can confer (#591).
    expect([...PLUGIN_UNIT_CONSENT_PUBLIC_READS].sort()).toEqual([
      'read:event:public',
      'read:event_occurrence:public',
      'read:event_policy:public',
      'read:game:public',
      'read:game_collection:public',
      'read:job',
      'read:media_object:public',
      'read:plugin:installed',
      'read:user:profile:public',
      'read:user:searchable',
    ]);

    for (const slug of PLUGIN_UNIT_CONSENT_PUBLIC_READS) {
      const entry = catalogEntry(slug);

      expect({
        slug,
        action: entry.action,
        variables: parseTemplate(entry.conditions).variables,
        bounding: hasBoundingConditions(entry.conditions),
      }).toEqual({
        slug,
        action: Action.read,
        variables: [],
        bounding: true,
      });
    }
  });
});

describe('judgeConsentDecision (#772)', () => {
  // The per-decision checks the plugin ability read applies, shared with the
  // permission catalog's count of the decisions an edit stops conferring, so
  // the two cannot disagree.
  /** `row` with a risk level, which the binding rule never reads and the risk check does. */
  const permission = <Row extends object>(row: Row, riskLevel: RiskLevel = RiskLevel.Low) => ({ ...row, riskLevel });
  const decision = (scopeType: PluginGrantScope, decidedRiskLevel: RiskLevel = RiskLevel.Low) => ({
    scopeType,
    decidedRiskLevel,
  });

  const householdBound = permission(ruleRow({ householdId: '{{ unit.householdId }}' }, ResourceType.Event));
  const unconditioned = permission(ruleRow({}, ResourceType.Event));

  it('confers a decision the unit binds, and a server decision on any permission, while its risk covers it', () => {
    expect(judgeConsentDecision(householdBound, decision(PluginGrantScope.Household))).toBe('confers');
    expect(judgeConsentDecision(unconditioned, decision(PluginGrantScope.Server))).toBe('confers');
    expect(judgeConsentDecision(permission(catalogRow('read:game:public')), decision(PluginGrantScope.User))).toBe(
      'confers',
    );
  });

  it('answers wildcard-subject for a permission on all, at every scope and risk, before anything else', () => {
    const wildcard = permission(ruleRow({}, 'all'));

    for (const scopeType of Object.values(PluginGrantScope)) {
      expect(judgeConsentDecision(wildcard, decision(scopeType, RiskLevel.Critical))).toBe('wildcard-subject');
    }
  });

  it('answers unit-unbound for a household or user decision on a permission its unit cannot bind', () => {
    expect(judgeConsentDecision(unconditioned, decision(PluginGrantScope.Household))).toBe('unit-unbound');
    expect(judgeConsentDecision(householdBound, decision(PluginGrantScope.User))).toBe('unit-unbound');
    // Unbound comes first: raising the risk too still answers it.
    expect(
      judgeConsentDecision(
        permission(ruleRow({}, ResourceType.Event), RiskLevel.High),
        decision(PluginGrantScope.User),
      ),
    ).toBe('unit-unbound');
  });

  it('answers stale-consent when the permission carries a higher risk than the decision was made under', () => {
    const raised = permission(ruleRow({ householdId: '{{ unit.householdId }}' }, ResourceType.Event), RiskLevel.Medium);

    expect(judgeConsentDecision(raised, decision(PluginGrantScope.Household, RiskLevel.Low))).toBe('stale-consent');
    expect(judgeConsentDecision(raised, decision(PluginGrantScope.Server, RiskLevel.Low))).toBe('stale-consent');
    expect(judgeConsentDecision(raised, decision(PluginGrantScope.Household, RiskLevel.Medium))).toBe('confers');
  });

  it('isWildcardSubject reads the subject alone', () => {
    expect(isWildcardSubject({ subject: 'all' })).toBe(true);
    expect(isWildcardSubject({ subject: ResourceType.Game })).toBe(false);
  });
});
