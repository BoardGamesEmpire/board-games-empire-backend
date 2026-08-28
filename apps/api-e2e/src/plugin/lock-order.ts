import { anyOf, type OrderedStage, relationLock } from '../support/shipped-function';

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
 *
 * ## What this model cannot see: FK-implied parent locks (#398, #399)
 *
 * Every stage here is matched from SOURCE — a written `FOR …` clause, or a
 * Prisma call known to lock. Postgres also takes locks nobody wrote: an INSERT
 * into a table with an FK to `plugins` takes `FOR KEY SHARE` on the parent row
 * from the referential-integrity trigger, and RI checks are AFTER ROW triggers,
 * so that lock lands only once the child tuple is already written. Four tables
 * carry that FK — `plugin_grants`, `household_plugins`, `plugin_permissions`,
 * `user_plugins` — so four child writes take a plugin-row lock this constant
 * cannot observe, in the LAST position rather than the first.
 *
 * `decide()` is how that was found: it claimed `['grant row', 'unit row']`, said
 * outright that it took no plugin-row lock, and deadlocked against activation's
 * `FOR UPDATE` on every contended grant INSERT while both the barrier suite and
 * the pin suite stayed green (#398). Its entries now claim the plugin row it
 * really does take, first, because the source now says so.
 *
 * The general fix — inferring the implicit stage rather than trusting the
 * written one — is #399. Until then the rule for a writer of any FK-child table
 * is: claim the plugin row explicitly, or be invisible to this model. The
 * deadlocks / does-not-deadlock pairs in the barrier spec are what actually hold
 * the order; a static reader of source cannot observe a trigger.
 */
export const CLAIMED_LOCK_ORDER = [
  {
    /**
     * Taken by the unit paths through `assertStillLiving`, and by uninstall and
     * activation as the claiming write they already make. Both are the plugin
     * row; what matters is that nothing else is taken before it.
     *
     * Activation also takes it by raw `FOR UPDATE` (D-CN, #370): the
     * server-config read guarding `Plugin.config` against a concurrent PATCH,
     * which now runs BEFORE the claiming `plugin.updateMany` below it — so
     * without this alternative, this stage would date to the later write and
     * a future statement placed between the two would silently order behind a
     * lock that, on the page, no longer looks like the first thing taken.
     *
     * The SQL alternatives go through `relationLock`, which is what scopes them
     * to the `plugins` table and to that name entire. A bare `FOR SHARE` or
     * `FOR UPDATE` would let a lock on ANY table date this stage — and since
     * order is judged by first occurrence, one taken earlier in a body would
     * report the plugin row as held before it was. It is only reached by the
     * replayed statement today, which is exactly when a loose pattern goes
     * unnoticed.
     *
     * Where the name is allowed to end is stated once, at `RELATION_END`,
     * rather than per stage. Three hand-written copies is how that rule got
     * tightened three times in review and needed correcting in three places
     * each time, and the copy nobody looks at is the one that stays loose.
     */
    name: 'plugin row',
    pattern: anyOf(
      /assertStillLiving\(/,
      relationLock('plugins', 'FOR SHARE'),
      relationLock('plugins', 'FOR UPDATE'),
      /tx\.plugin\.update/,
      /plugin\.updateMany/,
    ),
  },
  {
    /**
     * `decide()`'s upsert takes it; activation's `FOR UPDATE` takes it. The
     * idempotency pre-read in `decide()` is deliberately NOT matched — it runs
     * before the upsert and locks nothing, so counting it would date the stage
     * to a read that orders nothing.
     */
    name: 'grant row',
    pattern: anyOf(/pluginGrant\.upsert\(/, relationLock('plugin_grants', 'FOR UPDATE')),
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
    pattern: anyOf(
      /lock(?:Household|User)Unit\(/,
      /suspend(?:Household|User)Unit\(/,
      /tx\.(?:householdPlugin|userPlugin)\.(?:create|update|updateMany|upsert|delete|deleteMany)/,
      relationLock(['household_plugins', 'user_plugins'], 'FOR UPDATE'),
    ),
  },
] as const satisfies readonly OrderedStage[];

/**
 * The stage names, as a type.
 *
 * A path's stage list is data, and until now a typo in one was only reported
 * when the spec ran — by which time it had already been committed and reviewed
 * as if it named a stage. Deriving the union from the claim itself means the
 * constant stays the single place the order is stated AND the place a misspelt
 * claim is refused, at the point it is written.
 */
export type LockStageName = (typeof CLAIMED_LOCK_ORDER)[number]['name'];

/** One writer, and the stages of the claimed order it says it takes. */
export interface LockOrderPath {
  /** How a failure names it. */
  readonly label: string;

  readonly file: string;
  readonly functionName: string;

  /**
   * A subset of {@link CLAIMED_LOCK_ORDER}, by name. Every stage listed must be
   * taken — a claimed stage that stops matching is a failure, not a skip.
   *
   * Typed as a NON-EMPTY list of stage names rather than as strings. A path
   * that lost its entries would otherwise still typecheck, and an empty claim
   * is judged in order vacuously — the no-op pin this whole module is a
   * reaction to, arriving through the one door the runtime guard could not
   * watch.
   */
  readonly stages: readonly [LockStageName, ...LockStageName[]];

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
    stages: ['plugin row', 'grant row', 'unit row'],
    because:
      'The claim opens the transaction (#398), then the upsert takes the grant row, then the suspend mirror ' +
      'rides the same transaction. The plugin-row lock is not optional decoration: the grant INSERT takes ' +
      'FOR KEY SHARE on that row through the FK anyway, and takes it AFTER writing the grant tuple, so ' +
      'without the claim this path holds the plugin row LAST and deadlocks against activation.',
  },
  {
    label: 'decide() — the grant row precedes the unit-scope key',
    file: GRANT_SERVICE,
    functionName: 'decide',
    stages: ['plugin row', 'grant row', 'advisory key'],
    because:
      'The consent act is the enabling act (#225), so a granted user decision creates the anchor in the ' +
      'decision transaction — which puts the key after the upsert that already holds the grant row, and ' +
      'both after the claim that opens the transaction.',
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
      "Activation takes the plugin row first via D-CN's `FOR UPDATE` config read, ahead of the claiming write " +
      'that used to be this stage on its own (#370) — both are the plugin row, and either dates it. Then it ' +
      'locks server grants (#356), then WRITES units — its unit-set read comes earlier and is deliberately not ' +
      'the stage, because that read takes no lock at all (#361). It never takes the advisory key, which is ' +
      "exactly why the unit paths need the plugin row's share lock to order against it.",
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
 * for, refusing a claim that cannot mean what it says.
 *
 * Reordering matters most: a path entry that listed its stages in the wrong
 * order would otherwise define its own claim and pass, which is the single
 * thing this constant exists to prevent.
 *
 * The three refusals are all the same failure wearing different clothes — a
 * pin that reads as asserting something and asserts less:
 *
 *  - **A name that is not a stage** would silently drop that stage from the
 *    pin. `LockStageName` catches this in the repo's own source; the throw is
 *    what catches a list assembled from data, and what makes the reason legible
 *    when it does.
 *  - **An empty claim** is judged in order vacuously — `orderMismatch` finds
 *    nothing missing and has no pair to compare — so the pin passes over any
 *    body at all.
 *  - **A duplicated name** collapses in the filter below, so a claim of two
 *    stages becomes one, the comparison loop never runs, and the pin reports
 *    "in order" having ordered nothing against anything.
 */
export function stagesNamed(names: readonly string[]): readonly OrderedStage[] {
  if (names.length === 0) {
    throw new Error('A lock-order claim naming no stages asserts nothing; name the stages the path takes.');
  }

  const duplicated = names.filter((name, at) => names.indexOf(name) !== at);

  if (duplicated.length > 0) {
    throw new Error(
      `A lock-order claim names '${[...new Set(duplicated)].join("', '")}' more than once. Repeats collapse, so ` +
        `the pin would compare fewer stages than it reads as comparing. Claimed: ${names.join(' -> ')}.`,
    );
  }

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
export function stageNamed(name: LockStageName): OrderedStage {
  const stage = stagesNamed([name])[0];

  if (stage === undefined) {
    throw new Error(`'${name}' is not a stage of the claimed lock order.`);
  }

  return stage;
}
