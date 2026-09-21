/**
 * Resource types whose collection reads have NOT yet been moved onto the
 * intrinsic-scope invariant, pinned so the guard can ship live before the
 * sweep that satisfies it (418).
 *
 * Without this the guard could not be turned on at all: it fails a list whose
 * scope was never composed, and on the day the composer lands that is every
 * list in the tree. The alternatives were both worse — ship the mechanism
 * inert and rely on someone remembering to arm it later, or hold the composer
 * back until the whole sweep is done and lose the reference implementation
 * that proves the shape.
 *
 * So the pin is the sweep's own progress bar, and it only ever shrinks: 418
 * deletes an entry as it converts that resource, and `pending-scope-sweep.spec`
 * asserts the set is exactly this. An entry ADDED here is a new unscoped read,
 * which is the thing being eliminated — the spec makes that a deliberate,
 * reviewable act rather than a silent one.
 *
 * Empty means the sweep is complete and this file should be deleted along with
 * the branch in `assertListScopeComposed` that reads it.
 *
 * Mirrors the `UNCONDITIONED_SCOPED_GRANTS` pin from 234/432, for the same
 * reason: a known defect that is enumerated cannot quietly grow.
 */
export const PENDING_SCOPE_SWEEP: ReadonlySet<string> = Object.freeze(
  new Set([
    // Swept by 417 — the households reference implementation.
    'Household',

    // Swept by 418, in the groups the intrinsic-scope table names.
    'AuditLog',
    'Event',
    'EventGameNomination',
    'EventOccurrence',
    'Friendship',
    'Game',
    'GameCollection',
    'GameGateway',
    'HouseholdMember',
    'Job',
    'MediaContribution',
    'MediaObject',
    'Plugin',
    'User',
  ]),
);
