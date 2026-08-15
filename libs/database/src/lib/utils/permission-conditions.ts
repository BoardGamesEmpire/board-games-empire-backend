/**
 * Does a `Permission.conditions` value carry ANY bounding clause? The
 * consent model's unit-boundedness rule (#60) keys on this: a Household- or
 * User-scope grant confers a core permission only when the catalog row
 * carries SOME condition — a condition-free permission is subject-wide
 * authority, and nothing a unit consents to can bound subject-wide reach to
 * that unit's slice. Server-scope consent is exempt (server consent IS
 * server-wide authority).
 *
 * Shared from here because four seams must agree on what "condition-free"
 * means or the gate leaks between them: the install/update consent gates,
 * the decide() write path, the ability read path, and the consent
 * classification. Deliberately shape-only (non-null object with at least
 * one key) — whether the clause is a Mustache template or a static filter
 * is the ability factory's business, not this predicate's.
 */
export const hasBoundingConditions = (conditions: unknown): boolean =>
  conditions !== null && typeof conditions === 'object' && Object.keys(conditions).length > 0;
