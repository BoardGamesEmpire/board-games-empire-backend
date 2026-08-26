import type { OrderedStage } from '../support/shipped-function';

/**
 * The claimed total lock order of the plugin consent path, in ONE place.
 *
 * `plugin row (FOR SHARE) -> grant row -> advisory key -> unit row`, as merged
 * in PR #363. Every writer takes a prefix or a suffix of it, and taking two of
 * these locks in a different order than another writer is a deadlock cycle —
 * not hypothetically: the branch that became #323 opened advisory-first,
 * closing `advisory -> plugin -> grant -> advisory` against writers that
 * already existed, and it was inverted in review rather than in production.
 *
 * Before this constant the order lived in prose, in three service doc comments
 * that had to be kept in agreement by hand. Pinning it in one place is what
 * gives #361 — which may add a plugin-row lock to the decision transaction — a
 * single literal to amend, and what makes a writer that disagrees with the
 * claim surface as a red test rather than as reasoning in a PR description.
 *
 * The stages are LOCKS, not accesses, and the patterns are held to it. A unit
 * row READ under the advisory key is not a unit-row lock, so the two fused
 * openers below claim only the two stages they actually take — a pattern loose
 * enough to count their `findUnique` would also count activation's unlocked
 * scan, which the characterization spec beside this one exists to prove takes
 * no lock at all. Two specs in one PR cannot call the same statement locked and
 * unlocked.
 */
export const CLAIMED_LOCK_ORDER: readonly OrderedStage[] = [
  {
    /**
     * Taken by the unit paths as a `FOR SHARE` read, and by uninstall and
     * activation as the claiming write they already make. Both are the plugin
     * row; what matters is that nothing else is taken before it.
     */
    name: 'plugin row',
    pattern: /assertStillLiving\(|FOR SHARE|tx\.plugin\.update|plugin\.updateMany/,
  },
  {
    /**
     * `decide()`'s upsert takes it; activation's `FOR UPDATE` takes it. The
     * idempotency pre-read in `decide()` is deliberately NOT matched — it runs
     * before the upsert and locks nothing, so counting it would date the stage
     * to a read that orders nothing.
     */
    name: 'grant row',
    pattern: /pluginGrant\.upsert\(|FROM plugin_grants[^`]*?FOR UPDATE/,
  },
  {
    /** The `(scopeId, pluginId)` key, which exists before the unit row does. */
    name: 'advisory key',
    pattern: /lock(?:Household|User)UnitScope\(|pg_advisory_xact_lock/,
  },
  {
    /**
     * The unit row locked (`lockHouseholdUnit`), delegated to a pass that locks
     * it (`suspendHouseholdUnit`), or WRITTEN through Prisma, which locks it
     * just as surely. Reads are excluded: see the note above.
     */
    name: 'unit row',
    pattern:
      /lock(?:Household|User)Unit\(|suspend(?:Household|User)Unit\(|tx\.(?:householdPlugin|userPlugin)\.(?:create|update|updateMany|upsert|delete|deleteMany)|FROM (?:household_plugins|user_plugins)[^`]*?FOR UPDATE/,
  },
];

/** One writer, and the stages of the claimed order it says it takes. */
export interface LockOrderPath {
  /** How a failure names it. */
  readonly label: string;

  readonly file: string;
  readonly functionName: string;

  /**
   * A subset of {@link CLAIMED_LOCK_ORDER}, by name. Every stage listed must be
   * taken — a claimed stage that stops matching is a failure, not a skip.
   */
  readonly stages: readonly string[];

  /** Why this path takes that subset — the part a reader cannot infer. */
  readonly because: string;

  /**
   * Restricts the pin to the branch whose CONDITION matches, for a function
   * whose branches take locks independently.
   *
   * Order is judged by first occurrence, so without this the earlier branch's
   * stages date the later branch's claim and an inversion inside the later one
   * is invisible.
   */
  readonly branch?: RegExp;
}

const GRANT_SERVICE = 'libs/plugin/runtime/src/lib/grants/plugin-grant.service.ts';
const UNIT_LIFECYCLE = 'libs/plugin/runtime/src/lib/units/plugin-unit-lifecycle.service.ts';
const UPDATE_SERVICE = 'libs/plugin/runtime/src/lib/update/plugin-update.service.ts';
const LIFECYCLE_SERVICE = 'libs/plugin/runtime/src/lib/lifecycle/plugin-lifecycle.service.ts';

/** The files the pinned paths live in, so no spec retypes one. */
export const LOCK_SOURCES = {
  grantService: GRANT_SERVICE,
  unitLifecycle: UNIT_LIFECYCLE,
  updateService: UPDATE_SERVICE,
  lifecycleService: LIFECYCLE_SERVICE,
  unitScopeLock: 'libs/plugin/runtime/src/lib/grants/unit-scope-lock.ts',
} as const;

/**
 * Every writer that takes more than one of these locks.
 *
 * A path taking a single lock cannot be out of order with itself, so the list
 * is exactly the set where the claim has content. `decide()` appears twice
 * because its two branches are independent: a required denial delegates to a
 * suspend pass, a granted user decision creates the anchor, and neither runs in
 * the other's transaction — so checking their first occurrences against one
 * another would compare two paths that never interleave.
 */
export const LOCK_ORDER_PATHS: readonly LockOrderPath[] = [
  {
    label: 'openHouseholdUnit (every household unit transaction)',
    file: UNIT_LIFECYCLE,
    functionName: 'openHouseholdUnit',
    stages: ['plugin row', 'advisory key'],
    because:
      'The fused opener, so obtaining the unit row without the plugin row and the key has no convenient API. ' +
      'This is the path whose original order closed the cycle. It claims no unit-row lock because it takes ' +
      'none: Prisma exposes no row-lock API, and the key is what orders its read.',
  },
  {
    label: 'openUserUnit (every user unit transaction)',
    file: UNIT_LIFECYCLE,
    functionName: 'openUserUnit',
    stages: ['plugin row', 'advisory key'],
    because: 'The user-scope twin, which takes the same prefix for the same reason.',
  },
  {
    label: 'decide() — the required-denial branch',
    file: GRANT_SERVICE,
    functionName: 'decide',
    stages: ['grant row', 'unit row'],
    because:
      'The upsert takes the grant row, then the suspend mirror rides the same transaction. No plugin-row lock: ' +
      'the in-transaction re-judgment reads the plugin row unlocked, which is what #361 may change.',
  },
  {
    label: 'decide() — the grant row precedes the unit-scope key',
    file: GRANT_SERVICE,
    functionName: 'decide',
    stages: ['grant row', 'advisory key'],
    because:
      'The consent act is the enabling act (#225), so a granted user decision creates the anchor in the ' +
      'decision transaction — which puts the key after the upsert that already holds the grant row.',
  },
  {
    label: 'decide() — inside the granted user-anchor branch',
    file: GRANT_SERVICE,
    functionName: 'decide',
    branch: /Granted && input\.scopeType === PluginGrantScope\.User/,
    stages: ['advisory key', 'unit row'],
    because:
      'Scoped to the branch, because the two entries above are judged over the whole body and the mirror ' +
      'branch runs first — so an anchor created BEFORE its key still dated after the mirror and left them ' +
      'green. Taking those two the other way round is a cycle against the suspend pass, which takes exactly ' +
      'this suffix.',
  },
  {
    label: 'suspendHouseholdUnit (the mirror suspend pass)',
    file: GRANT_SERVICE,
    functionName: 'suspendHouseholdUnit',
    stages: ['advisory key', 'unit row'],
    because: 'A suffix of the order: the key before the row, so it waits out an uncommitted creation.',
  },
  {
    label: 'suspendUserUnit (the mirror suspend pass, user scope)',
    file: GRANT_SERVICE,
    functionName: 'suspendUserUnit',
    stages: ['advisory key', 'unit row'],
    because: 'The user-scope twin of the same suffix.',
  },
  {
    label: 'activateInTransaction (approval)',
    file: UPDATE_SERVICE,
    functionName: 'activateInTransaction',
    stages: ['plugin row', 'grant row', 'unit row'],
    because:
      'Activation claims the plugin row through its own guarded write, then locks server grants (#356), then ' +
      'WRITES units — its unit-set read comes earlier and is deliberately not the stage, because that read ' +
      'takes no lock at all (#361). It never takes the advisory key, which is exactly why the unit paths need ' +
      "the plugin row's share lock to order against it.",
  },
  {
    label: 'uninstall (the purge)',
    file: LIFECYCLE_SERVICE,
    functionName: 'uninstall',
    stages: ['plugin row', 'unit row'],
    because:
      'The purge deletes unit rows without joining the advisory scheme, so the plugin row is the only thing ' +
      'ordering it against a unit writer — the reason the `FOR SHARE` exists at all.',
  },
];

/**
 * The named stages, in the CLAIMED order rather than the order they were asked
 * for, refusing a name that is not a stage.
 *
 * Both halves matter. A typo would silently drop a stage from a path's pin,
 * leaving it asserting less than it reads as asserting; and a path entry that
 * listed its stages in the wrong order would otherwise define its own claim and
 * pass, which is the single thing this constant exists to prevent.
 */
export function stagesNamed(names: readonly string[]): readonly OrderedStage[] {
  for (const name of names) {
    if (!CLAIMED_LOCK_ORDER.some((stage) => stage.name === name)) {
      throw new Error(
        `'${name}' is not a stage of the claimed lock order ` +
          `(${CLAIMED_LOCK_ORDER.map((stage) => stage.name).join(', ')}).`,
      );
    }
  }

  return CLAIMED_LOCK_ORDER.filter((stage) => names.includes(stage.name));
}

/**
 * One stage by name, typed.
 *
 * Exists so the specs that need a single stage's pattern do not reach for it
 * through a `find` and a cast — a cast to an anonymous shape switches off the
 * typechecking on the very code whose job is to notice drift.
 */
export function stageNamed(name: string): OrderedStage {
  const stage = stagesNamed([name])[0];

  if (stage === undefined) {
    throw new Error(`'${name}' is not a stage of the claimed lock order.`);
  }

  return stage;
}
