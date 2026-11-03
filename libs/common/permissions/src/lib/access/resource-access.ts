import { Action, type ResourceType } from '@bge/database';
import { accessibleBy } from '@casl/prisma';
import { abilityOfRules } from '../ability-of-rules';
import type { AppAbility, ModelResourceType } from '../interfaces';

/** Every {@link AccessExtent}, for the OpenAPI enum (#757). */
export const ACCESS_EXTENTS = ['all', 'some', 'none'] as const;

/**
 * How far an actor's permissions reach for one action on one resource type
 * (#757): every record, some of them, or none. See {@link accessExtent}.
 */
export type AccessExtent = (typeof ACCESS_EXTENTS)[number];

/** An actor's access to one resource type: one {@link AccessExtent} for each action. */
export type ResourceTypeAccess = Record<Action, AccessExtent>;

/** An actor's access to each resource type it asked about (#757). */
export type ActorAccess = Partial<Record<ResourceType, ResourceTypeAccess>>;

/**
 * How far `abilities` reach for `action` on `resourceType`, judged the way the
 * server's own checks judge a request (#757):
 *
 * - `none`: a route that checks this action on this resource type refuses
 *   the actor. Some ability holds no permission that allows it.
 * - `all`: every ability reaches every record, with no condition, and no
 *   permission on the pair is limited to some fields.
 * - `some`: everything in between, such as a grant with a condition, an API
 *   key pinned to one record, or a grant or denial limited to some fields.
 *   The server decides each request by its conditions, or with a 403.
 *
 * Every ability counts, as `PoliciesGuard` counts them: for an API key the
 * answer is the narrower of the key and its owner. An empty array is `none`.
 *
 * A `manage` permission answers for every other action, because CASL counts it for
 * each. The reverse never holds: holding the other four actions leaves
 * `manage` at `none`, because a route that checks `manage` refuses that actor.
 *
 * Throws where the matcher cannot read a condition, as the guard's own check
 * does. {@link resourceTypeAccess} answers that pair `none`.
 */
export function accessExtent(
  abilities: readonly AppAbility[],
  action: Action,
  resourceType: ResourceType,
): AccessExtent {
  if (abilities.length === 0) {
    return 'none';
  }

  const extents = abilities.map((ability) => extentFor(ability, action, resourceType));

  if (extents.includes('none')) {
    return 'none';
  }

  return extents.every((extent) => extent === 'all') ? 'all' : 'some';
}

/**
 * {@link accessExtent} for every action on `resourceType`, in `Action` order
 * (#757). An action whose permissions the matcher cannot read is reported to
 * `onUnreadable` and answered `none`, so the other actions keep their answer.
 * The server's own checks cannot read that permission either, and refuse or
 * fail on it.
 */
export function resourceTypeAccess(
  abilities: readonly AppAbility[],
  resourceType: ResourceType,
  onUnreadable: (action: Action, error: unknown) => void,
): ResourceTypeAccess {
  return Object.fromEntries(
    Object.values(Action).map((action) => {
      try {
        return [action, accessExtent(abilities, action, resourceType)];
      } catch (error) {
        onUnreadable(action, error);

        return [action, 'none'];
      }
    }),
  ) as ResourceTypeAccess;
}

/** {@link accessExtent} for one ability (#757). */
function extentFor(ability: AppAbility, action: Action, resourceType: ResourceType): AccessExtent {
  // The guard's own type check: no permission that allows the pair is a refusal.
  if (!ability.can(action, resourceType)) {
    return 'none';
  }

  // Every rule for the pair, whatever its fields, highest priority first.
  const rules = ability.possibleRulesFor(action, resourceType);

  // With no field list anywhere, the ability's own clause is the answer.
  if (rules.every((rule) => !rule.fields)) {
    return reachesEveryRecord(ability, action, resourceType) ? 'all' : 'some';
  }

  // `accessibleBy` reads rows and ignores fields, so a field-limited grant with
  // no condition would build `{}`. Only rules that cover every field count.
  if (!reachesEveryRecord(abilityOfRules(rules.filter((rule) => !rule.fields)), action, resourceType)) {
    return 'some';
  }

  // A denial bound to a field never reaches a check that names no field, so
  // CASL leaves it out of both `can` and `accessibleBy`. Each field a denial
  // names is checked as a check on that field would be, priority kept: a
  // higher-priority grant of every field overrides the denial.
  const deniedFields = new Set(rules.flatMap((rule) => (rule.inverted && rule.fields ? rule.fields : [])));

  for (const field of deniedFields) {
    const forField = abilityOfRules(ability.rulesFor(action, resourceType, field));

    if (!reachesEveryRecord(forField, action, resourceType)) {
      return 'some';
    }
  }

  return 'all';
}

/** Whether `ability`'s clause for `action` on `resourceType` admits every row (#757). */
function reachesEveryRecord(ability: AppAbility, action: Action, resourceType: ResourceType): boolean {
  return Object.keys(accessibleBy(ability, action).ofType(resourceType as ModelResourceType)).length === 0;
}
