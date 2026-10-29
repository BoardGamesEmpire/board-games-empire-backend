import { Action, PluginGrantScope } from '../client';
import { parseTemplate } from './catalog-guards';
import { PERMISSION_CATALOG } from './permission.catalog';
import {
  bindsConsentUnit,
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

const UNIT_SCOPES: readonly PluginUnitGrantScope[] = [PluginGrantScope.Household, PluginGrantScope.User];

describe('bindsConsentUnit (#591)', () => {
  it.each<[string, unknown, PluginUnitGrantScope, boolean]>([
    ["names the household's own id", { householdId: '{{ unit.householdId }}' }, PluginGrantScope.Household, true],
    ["names the user's own id", { ownerId: '{{ unit.userId }}' }, PluginGrantScope.User, true],
    [
      'names the unit id beside the plugin id',
      { householdId: '{{ unit.householdId }}', pluginId: '{{ plugin.id }}' },
      PluginGrantScope.Household,
      true,
    ],
    [
      "names the wrong unit's id at household scope",
      { ownerId: '{{ unit.userId }}' },
      PluginGrantScope.Household,
      false,
    ],
    [
      "names the wrong unit's id at user scope",
      { householdId: '{{ unit.householdId }}' },
      PluginGrantScope.User,
      false,
    ],
    [
      'names a variable outside the plugin render context beside the unit id',
      { householdId: '{{ unit.householdId }}', createdById: '{{ user.id }}' },
      PluginGrantScope.Household,
      false,
    ],
    ['names a role-pass variable', { householdId: '{{ householdId }}' }, PluginGrantScope.Household, false],
    ['names the acting user', { userId: '{{ user.id }}' }, PluginGrantScope.User, false],
    ['carries fixed conditions only', { deletedAt: { not: null } }, PluginGrantScope.Household, false],
    ['names the plugin but no unit id', { pluginId: '{{ plugin.id }}' }, PluginGrantScope.Household, false],
    ['carries no conditions (null)', null, PluginGrantScope.Household, false],
    ['carries no conditions ({})', {}, PluginGrantScope.Household, false],
    ['does not parse', { householdId: '{{ unit.householdId }' }, PluginGrantScope.Household, false],
    // Where the id sits decides whether it binds: rows outside the unit must
    // not match.
    [
      'matches the id with equals',
      { householdId: { equals: '{{ unit.householdId }}' } },
      PluginGrantScope.Household,
      true,
    ],
    [
      'matches the id through an is relation filter',
      { household: { is: { id: '{{ unit.householdId }}' } } },
      PluginGrantScope.Household,
      true,
    ],
    [
      'matches the id through a some relation filter',
      { members: { some: { userId: '{{ unit.userId }}' } } },
      PluginGrantScope.User,
      true,
    ],
    [
      'matches the id inside AND',
      { AND: [{ deletedAt: null }, { householdId: '{{ unit.householdId }}' }] },
      PluginGrantScope.Household,
      true,
    ],
    [
      'matches the id beside an OR that narrows further',
      { householdId: '{{ unit.householdId }}', OR: [{ reach: 'Public' }, { deletedAt: null }] },
      PluginGrantScope.Household,
      true,
    ],
    ['negates the id', { householdId: { not: '{{ unit.householdId }}' } }, PluginGrantScope.Household, false],
    ['negates the id under NOT', { NOT: { householdId: '{{ unit.householdId }}' } }, PluginGrantScope.Household, false],
    [
      'offers the id under OR beside a fixed branch',
      { OR: [{ householdId: '{{ unit.householdId }}' }, { deletedAt: { not: null } }] },
      PluginGrantScope.Household,
      false,
    ],
    [
      'names the id only as a section',
      { householdId: '{{#unit.householdId}}{{/unit.householdId}}' },
      PluginGrantScope.Household,
      false,
    ],
    [
      'embeds the id in surrounding text',
      { householdId: 'prefix-{{ unit.householdId }}' },
      PluginGrantScope.Household,
      false,
    ],
    ['compares the id by range', { householdId: { gte: '{{ unit.householdId }}' } }, PluginGrantScope.Household, false],
    [
      'matches the id by substring',
      { householdId: { contains: '{{ unit.householdId }}' } },
      PluginGrantScope.Household,
      false,
    ],
    [
      'excludes the id through isNot',
      { household: { isNot: { id: '{{ unit.householdId }}' } } },
      PluginGrantScope.Household,
      false,
    ],
    [
      'requires the id of every related row, which no related row satisfies vacuously',
      { members: { every: { userId: '{{ unit.userId }}' } } },
      PluginGrantScope.User,
      false,
    ],
    [
      'excludes the id through none',
      { members: { none: { userId: '{{ unit.userId }}' } } },
      PluginGrantScope.User,
      false,
    ],
  ])('%s', (_label, conditions, scope, expected) => {
    expect(bindsConsentUnit({ slug: 'test:slug', conditions }, scope)).toBe(expected);
  });

  it('admits every allowlisted public read at both unit scopes', () => {
    for (const slug of PLUGIN_UNIT_CONSENT_PUBLIC_READS) {
      const { conditions } = catalogEntry(slug);

      for (const scope of UNIT_SCOPES) {
        expect({ slug, scope, binds: bindsConsentUnit({ slug, conditions }, scope) }).toEqual({
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

      expect(bindsConsentUnit({ slug, conditions }, PluginGrantScope.Household)).toBe(false);
    });

    it('admits one that gained a clause binding the consenting unit', () => {
      const conditions = { ...(catalogEntry(slug).conditions as object), householdId: '{{ unit.householdId }}' };

      expect(bindsConsentUnit({ slug, conditions }, PluginGrantScope.Household)).toBe(true);
    });

    it.each([null, {}])('refuses one that lost its conditions (%p): it would read every row', (conditions) => {
      expect(bindsConsentUnit({ slug, conditions }, PluginGrantScope.Household)).toBe(false);
    });
  });

  it('refuses the three fixed-condition slugs left off the allowlist', () => {
    for (const slug of ['update:household:restore', 'update:household:restore:administer', 'create:event']) {
      const { conditions } = catalogEntry(slug);

      for (const scope of UNIT_SCOPES) {
        expect({ slug, scope, binds: bindsConsentUnit({ slug, conditions }, scope) }).toEqual({
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

      expect({ slug, action: entry.action, variables: parseTemplate(entry.conditions).variables }).toEqual({
        slug,
        action: Action.read,
        variables: [],
      });
    }
  });
});
