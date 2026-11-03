import { createPrismaAbility } from '@casl/prisma';
import type { AppAbility } from './interfaces';

type AbilityRule = ReturnType<AppAbility['rulesFor']>[number];

/**
 * An ability built from `rules`, a selection CASL handed back from
 * `rulesFor` or `possibleRulesFor` (#757). CASL returns them highest priority
 * first, and a built ability takes its last rule as the highest, so they are
 * reversed to keep a later denial winning.
 *
 * Their fields are dropped once the selection is made. A clause built with no
 * field named skips a field-bound denial, so a selection made for one field
 * would otherwise lose the denials that made it.
 */
export function abilityOfRules(rules: readonly AbilityRule[]): AppAbility {
  return createPrismaAbility(rules.map((rule) => ({ ...rule.origin, fields: undefined })).reverse()) as AppAbility;
}
