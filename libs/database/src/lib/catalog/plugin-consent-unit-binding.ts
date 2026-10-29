import * as Mustache from 'mustache';
import { PluginGrantScope } from '../client';
import { parseTemplate } from './catalog-guards';
import { matchesCatalogRule, type PermissionRuleColumns } from './catalog-reconcile-plan';
import { PERMISSION_CATALOG } from './permission.catalog';
import type { PermissionSeedDefinition } from './seed-definitions';

/** The decision scopes below server, where a single unit's consent decides. */
export type PluginUnitGrantScope = typeof PluginGrantScope.Household | typeof PluginGrantScope.User;

/**
 * The fixed-condition core permissions a unit may consent to although their
 * conditions name no unit (#591). Each reads only what anyone may already
 * see, so a plugin holding it on one unit's say-so reaches nothing that unit
 * could not show it. Reads only: a fixed-condition write reaches every
 * matching row install-wide. Declared eligibility (#226) replaces this list
 * when it lands.
 */
export const PLUGIN_UNIT_CONSENT_PUBLIC_READS: ReadonlySet<string> = new Set([
  'read:game:public',
  'read:game_collection:public',
  'read:media_object:public',
  'read:job',
  'read:plugin:installed',
  'read:user:searchable',
  'read:user:profile:public',
  'read:event:public',
  'read:event_occurrence:public',
  'read:event_policy:public',
]);

/** The catalog's rule for each allowlisted read, which its row must still hold. */
const PUBLIC_READ_RULES = new Map<string, PermissionSeedDefinition>(
  PERMISSION_CATALOG.filter(({ slug }) => PLUGIN_UNIT_CONSENT_PUBLIC_READS.has(slug)).map(
    (definition) => [definition.slug, definition] as const,
  ),
);

/** The scope's own id, which a unit-scope template must name. */
const UNIT_ID_VARIABLE: Readonly<Record<PluginUnitGrantScope, string>> = {
  [PluginGrantScope.Household]: 'unit.householdId',
  [PluginGrantScope.User]: 'unit.userId',
};

/**
 * What the plugin ability's render context supplies at each unit scope:
 * `AbilityFactory.createForPlugin` renders core templates against
 * `{ plugin: { id, slug }, unit }`. The factory spec pins this map to what
 * the factory actually renders, so the two cannot drift apart unnoticed.
 */
export const PLUGIN_UNIT_RENDER_VARIABLES: Readonly<Record<PluginUnitGrantScope, ReadonlySet<string>>> = {
  [PluginGrantScope.Household]: new Set(['plugin.id', 'plugin.slug', 'unit.scopeType', 'unit.householdId']),
  [PluginGrantScope.User]: new Set(['plugin.id', 'plugin.slug', 'unit.scopeType', 'unit.userId']),
};

/**
 * Why a refused permission binds nothing, for the consent seams' refusals and
 * warnings. One wording, so the seams that share the rule share its
 * explanation.
 */
export const CONSENT_UNIT_BINDING_REFUSAL =
  "its conditions do not restrict it to the consenting unit's own id, and it is not an allowlisted public " +
  'read, so nothing binds the conferred authority to the consenting unit';

/**
 * Whether a unit's consent can bind a core permission to that unit (#591):
 * the rule every consent seam applies below server scope, so the install and
 * update gates, `decide()`, the consent classification and the ability read
 * cannot disagree on what a household or a user may consent to.
 *
 * A permission binds when its conditions restrict every row to the consenting
 * unit's own id (`unit.householdId` at Household scope, `unit.userId` at User
 * scope), and every variable they name is one the plugin render context
 * supplies at that scope. Restricting means an equality on the id that every
 * matching row must satisfy: `field: '{{ unit.householdId }}'` or
 * `field: { equals: ... }`, at the top level or inside `AND`, directly or
 * through an `is` or `some` relation filter. Anything else binds nothing:
 *
 * - No conditions: subject-wide authority, which only server consent confers.
 * - Fixed conditions, with no variable: every matching row install-wide. With
 *   `update:household:restore` (`{ deletedAt: { not: null } }`), one
 *   household's consent would let the plugin restore every deleted household.
 * - The id named anywhere else: under `OR` beside a fixed branch, under `NOT`,
 *   `not`, `isNot`, `every` or `none`, or behind a range or text operator. The
 *   variable is there, but rows outside the unit still match.
 * - A section anywhere in the conditions, even one that leaves the id alone:
 *   a section can span fields or keys, and rendering it can drop the equality.
 * - A tag in any key. Keys render too, and `JSON.parse` keeps the last of two
 *   equal keys, so a rendered key can replace the id equality or choose the
 *   field the id is compared to.
 * - Another unit's id, a variable the context does not supply, or a template
 *   that does not parse: the rule would bind to the wrong unit, or the
 *   factory would refuse the plugin's whole ability.
 *
 * The {@link PLUGIN_UNIT_CONSENT_PUBLIC_READS} are the one exception, and
 * only while their row still holds the catalog's rule for the slug: the same
 * action, subject, fields, inversion and fixed conditions. An Admin-owned row
 * keeps its drift, and the plugin ability applies the row as stored, so the
 * slug alone proves nothing. A template added to one later is judged by the
 * rule above, so a row the factory would refuse fails here, for that
 * permission alone.
 */
export function bindsConsentUnit(
  permission: PermissionRuleColumns & { readonly slug: string },
  scope: PluginUnitGrantScope,
): boolean {
  const { variables, problems } = parseTemplate(permission.conditions);

  if (problems.length > 0) {
    return false;
  }

  if (variables.length === 0) {
    const catalogRule = PUBLIC_READ_RULES.get(permission.slug);

    return catalogRule !== undefined && matchesCatalogRule(catalogRule, permission);
  }

  const context = PLUGIN_UNIT_RENDER_VARIABLES[scope];

  return (
    variables.every((variable) => context.has(variable)) &&
    !hasSection(permission.conditions) &&
    !hasTemplatedKey(permission.conditions) &&
    restrictsToUnit(permission.conditions, UNIT_ID_VARIABLE[scope])
  );
}

/**
 * Whether the serialized conditions hold a section anywhere. The factory
 * renders the whole serialized object, so a section opened in one field and
 * closed in another can remove the id equality between them after the
 * structural read below accepted it. Any nested section sits inside a
 * top-level one, so the top level is enough. Called only on a template
 * `parseTemplate` already parsed.
 */
const hasSection = (conditions: unknown): boolean =>
  Mustache.parse(JSON.stringify(conditions)).some(([type]) => type === '#' || type === '^');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether a key at any depth opens a tag. `parseTemplate` refuses a delimiter
 * change, so every tag opens with `{{`. A tag that opens in a value and closes
 * in a key names JSON punctuation, which no render context supplies, so the
 * variable check has already refused it.
 */
const hasTemplatedKey = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(hasTemplatedKey);
  }

  return (
    isRecord(value) && Object.entries(value).some(([key, nested]) => key.includes('{{') || hasTemplatedKey(nested))
  );
};

/** A string that is the unit id tag and nothing else: no section, no surrounding text. */
const isUnitIdTag = (value: unknown, variable: string): boolean => {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    const [token, ...rest] = Mustache.parse(value);

    return (
      token !== undefined && rest.length === 0 && (token[0] === 'name' || token[0] === '&') && token[1] === variable
    );
  } catch {
    return false;
  }
};

/**
 * Whether a `where` clause holds every row to the unit id: some clause every
 * row must satisfy is an equality on it. Each key of a `where` must hold, and
 * so must each element of `AND`, so one such clause is enough. `OR`, `NOT`
 * and every other operator are left unread, because a row can match them
 * without matching the id.
 */
function restrictsToUnit(where: unknown, variable: string): boolean {
  if (!isRecord(where)) {
    return false;
  }

  return Object.entries(where).some(([key, value]) => {
    if (key === 'AND') {
      return (Array.isArray(value) ? value : [value]).some((clause) => restrictsToUnit(clause, variable));
    }

    if (key === 'OR' || key === 'NOT') {
      return false;
    }

    if (isUnitIdTag(value, variable)) {
      return true;
    }

    return (
      isRecord(value) &&
      (isUnitIdTag(value['equals'], variable) ||
        restrictsToUnit(value['is'], variable) ||
        restrictsToUnit(value['some'], variable))
    );
  });
}
