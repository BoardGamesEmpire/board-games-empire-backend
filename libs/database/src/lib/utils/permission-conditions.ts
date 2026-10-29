/**
 * Does a `Permission.conditions` value carry ANY clause? Deliberately
 * shape-only (non-null object with at least one key): whether the clause is
 * a Mustache template or a static filter is the caller's business, not this
 * predicate's. The catalog guards and the read-ceiling builder use it to
 * tell a condition-free permission from a conditioned one.
 *
 * It is not the plugin consent model's unit-boundedness rule. Some clause is
 * not enough there, since a fixed filter binds no unit; the consent seams
 * use `bindsConsentUnit` instead (#591).
 */
export const hasBoundingConditions = (conditions: unknown): boolean =>
  conditions !== null && typeof conditions === 'object' && Object.keys(conditions).length > 0;
