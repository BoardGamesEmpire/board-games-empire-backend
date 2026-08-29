import { type ChildRelation, childRelationsOf } from '../support/schema-relations';
import {
  anyOf,
  auditedWrites,
  claimsIncludingDelegates,
  fieldNamed,
  modelWrite,
  type OrderedStage,
  relationInsert,
  relationLock,
  type SourceSite,
  type WriteShape,
} from '../support/shipped-function';
import { readShippedTree } from '../support/shipped-sql';

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
 * The rule that gap left in prose is now enforced (#399): every write to an
 * FK-child table in the plugin runtime must be preceded, on every path that
 * reaches it, by a plugin-row claim. {@link fkChildWriteAudit} below is that
 * check, over tables read from the Prisma schema rather than from a list — a
 * hand-kept list of the four is the same blind spot one level out.
 *
 * It is a REQUIREMENT check and deliberately not a fifth stage. A stage is a
 * first occurrence in a body, and the implied lock's honest position is AFTER
 * the child write, which `orderMismatch` cannot express; a model that placed
 * the stage where it can be represented rather than where the lock is would be
 * less truthful than saying plainly that the parent must be held.
 *
 * The deadlocks / does-not-deadlock pairs in the barrier spec remain the proof
 * of record, and this check is judged against them rather than in place of
 * them: a static reader of source cannot observe a trigger.
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

/**
 * The installer, which takes no entry in {@link LOCK_ORDER_PATHS}.
 *
 * Named here anyway, because the FK-implied-lock audit below has an exemption
 * pointing at it — and a path spelled out inside an exemption is a path nothing
 * checks the spelling of.
 */
const INSTALLER_SERVICE = 'libs/plugin/runtime/src/lib/install/plugin-installer.service.ts';

/** The files the pinned paths live in, so no spec retypes one. */
export const LOCK_SOURCES = {
  grantService: GRANT_SERVICE,
  unitLifecycle: UNIT_LIFECYCLE,
  updateService: UPDATE_SERVICE,
  lifecycleService: LIFECYCLE_SERVICE,
  installerService: INSTALLER_SERVICE,
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

/* -------------------------------------------------------------------------- *
 * Locks nobody wrote: the FK-implied parent lock (#399)
 * -------------------------------------------------------------------------- */

/**
 * The parent model whose row every FK child implicitly locks.
 *
 * Named as the MODEL rather than the table because the schema is what is being
 * read: `@@map` is the only place the Postgres name is stated, and the whole
 * point of deriving is not to be the second place that has an opinion.
 */
export const FK_CHILD_PARENT = 'Plugin';

/** The parent's own Prisma accessor, which a nested child write goes through. */
const FK_CHILD_PARENT_ACCESSOR = 'plugin';

/**
 * The tables carrying an FK to `plugins`, as this suite claims they are.
 *
 * Pinned as a literal AND derived from the schema, and the pair is the point.
 * Deriving alone can quietly find nothing — a relation syntax this reader stops
 * recognising returns an empty set, and an empty set has no violations in it.
 * A literal alone goes stale the day a fifth child table lands, which is the
 * exact event this whole check exists for. Held against each other, a new child
 * table fails loudly and says to extend the pin.
 */
export const FK_CHILD_TABLES = ['household_plugins', 'plugin_grants', 'plugin_permissions', 'user_plugins'] as const;

/**
 * The tree scanned for writes to them.
 *
 * The plugin runtime entire, not the four files `LOCK_SOURCES` names. Scoping
 * this to the pinned paths would inherit the blind spot it closes:
 * `plugin-installer.service.ts` writes two of these tables and has no entry in
 * {@link LOCK_ORDER_PATHS} at all — it is compliant, and nothing here would
 * have said so.
 */
export const FK_CHILD_WRITE_SCOPE = 'libs/plugin/runtime/src/lib';

/**
 * The Prisma methods that INSERT, which is one of the two ways the implied
 * parent lock is taken.
 *
 * `createManyAndReturn` is here because the client has it (Prisma 7), not
 * because the tree uses it. `modelWrite` anchors the method name, so a method
 * this list forgets is not a near miss — the write matches nothing, the audit
 * finds no site, and the tree reports clean. That is the blind spot the derived
 * table list closes, one level further down.
 */
const FK_CHILD_INSERT_METHODS = ['create', 'createMany', 'createManyAndReturn', 'upsert'] as const;

/**
 * The other way: an UPDATE that changes the key.
 *
 * Postgres skips the referential-integrity check on an UPDATE whose key columns
 * are unchanged, so these count only when the payload names the FK field — the
 * `withArguments` guard below. Without it every dormancy write and every
 * `updateMany({ enabled })` in the tree reports as an FK-child write and wants
 * an exemption saying it takes no parent lock, which is noise standing exactly
 * where a real finding would appear.
 *
 * A child DELETE takes no parent lock at all and is absent for that reason.
 * The one shape not matched is a RAW `UPDATE … SET plugin_id = …`. Note that
 * the tree currently ships NO raw child write of any kind — the `relationInsert`
 * shape matches nothing today, which is why the liveness case below tests every
 * shape against a sample rather than trusting an empty result to mean a clean
 * tree.
 */
const FK_CHILD_REPARENT_METHODS = ['update', 'updateMany', 'updateManyAndReturn'] as const;

/**
 * A write knowingly not preceded by a claim, and why that is safe anyway.
 *
 * An exemption is a claim in its own right, so it is held to the same rule as
 * every other pin here: {@link fkChildWriteAudit} carries a case asserting
 * that each one still names a real unclaimed site. An exemption for a site that
 * started passing on its own is not harmless — it is a comment asserting a
 * danger that no longer exists, sitting next to the mechanism that would have
 * reported it.
 */
export interface ClaimExemption {
  readonly file: string;

  /** The enclosing function, as the scan names it. */
  readonly enclosing: string;

  /** Matched against the site's own text, so a moved line does not break it. */
  readonly site: RegExp;

  /** The part a reader cannot infer: why no claim is needed. */
  readonly because: string;
}

/**
 * The sites that take no dominating plugin-row claim and are safe regardless.
 *
 * One shape, twice. `persist()` reaches both writes through an `if/else` that
 * claims the plugin row on the REINSTALL arm (`plugin.updateMany`, guarded on
 * the tombstone) and creates it on the FRESH-INSTALL arm. The reinstall path is
 * ordered by the claim like every other writer; the fresh path holds no lock
 * and cannot need one.
 *
 * Note what is NOT done here: `tx.plugin.create` is not added to the
 * `'plugin row'` stage pattern. A `create` on a row this transaction just
 * inserted is not the ordering claim a `FOR SHARE` is, and admitting it as one
 * would let a genuinely late claim date early somewhere else — the failure the
 * stage patterns are scoped so carefully to avoid (#399).
 */
export const PLUGIN_ROW_CLAIM_EXEMPTIONS: readonly ClaimExemption[] = [
  {
    file: INSTALLER_SERVICE,
    enclosing: 'persist',
    site: /pluginPermission\.create/,
    because:
      'Fresh install CREATES the plugin row in this transaction (plugin.create), so the FK check locks a tuple ' +
      'no other transaction can see or queue behind and no cycle is expressible; reinstall claims the row ' +
      'through the tombstone-guarded plugin.updateMany on the other arm of the same if/else.',
  },
  {
    file: INSTALLER_SERVICE,
    enclosing: 'persist',
    site: /pluginGrant\.create/,
    because: 'The seeded server grants, reached by the same two branches and safe for the same two reasons.',
  },
];

/** One FK-child write the scan found, with the exemption covering it if any. */
export interface AuditedFkChildWrite extends SourceSite {
  readonly exemption: ClaimExemption | undefined;
}

let audited: readonly AuditedFkChildWrite[] | undefined;

/**
 * Every FK-child write in {@link FK_CHILD_WRITE_SCOPE}, audited.
 *
 * Computed on first ask and kept, rather than at module load. Three other specs
 * import this module for `LOCK_SOURCES` alone, and the scan parses the plugin
 * runtime whole and can REFUSE — an unreadable schema, a child with no `@@map`.
 * At module load that refusal lands as an import error in a spec that never
 * asked, naming neither the check nor the reason; here it lands inside the case
 * that wanted the answer.
 */
export function fkChildWriteAudit(): readonly AuditedFkChildWrite[] {
  audited ??= auditFkChildWrites();

  return audited;
}

/**
 * The write shapes, one per way a child row can be inserted or re-parented.
 *
 * Built from the schema so the accessor, the table and the FK field of each
 * child always agree with each other. Each re-parent shape is paired with ITS
 * OWN foreign key rather than a pooled guard over all four: pooling emits the
 * same alternative four times today, and the day one child keys differently it
 * would count a write of another child's column as a re-parent, producing a
 * site whose exemption could only say "that is not this table's key".
 */
export function fkChildWriteShapes(children: readonly ChildRelation[]): readonly WriteShape[] {
  const accessors = children.map((child) => child.accessor);

  return [
    { pattern: modelWrite(accessors, [...FK_CHILD_INSERT_METHODS]) },
    { pattern: relationInsert(children.map((child) => child.table)) },
    ...children.map((child) => ({
      pattern: modelWrite([child.accessor], [...FK_CHILD_REPARENT_METHODS]),
      withArguments: fieldNamed([child.foreignKey]),
      // `data`, not the whole call. Activation's grant re-stamp is addressed by
      // its compound unique key, so `where` names `pluginId` while `data`
      // rewrites four other columns — a guard over the whole call reports it,
      // and would report every keyed child update in the tree with it.
      argumentProperty: 'data',
    })),
    {
      // A NESTED write through the parent accessor
      // (`plugin.update({ data: { grants: { create: … } } })`) inserts child
      // rows just as surely, and names no child accessor while doing it.
      //
      // Judged on the WHOLE call, deliberately, where every other guard here
      // narrows to `data`. Narrowing would route this through the unreadable
      // rule, and a parent write's payload is unreadable most of the time —
      // `plugin.create` and `plugin.updateMany` both spread their column sets.
      // That rule is right for a guard asking "does this name the key?", where
      // not knowing means it might; it is wrong for one asking "is this a
      // nested write?", where not knowing would report every parent write in
      // the tree. Seven of them, none a child write.
      pattern: modelWrite([FK_CHILD_PARENT_ACCESSOR], [...FK_CHILD_INSERT_METHODS, ...FK_CHILD_REPARENT_METHODS]),
      withArguments: /\b(?:create|createMany|connectOrCreate)\s*:\s*[[{]/,
    },
  ];
}

function auditFkChildWrites(): readonly AuditedFkChildWrite[] {
  const children = childRelationsOf(FK_CHILD_PARENT);
  const writes = fkChildWriteShapes(children);
  // The stage's own pattern, not a second copy of it. A hand-written twin is
  // how the plugin row would come to mean one thing to the order pins and
  // another to this check, and the day they disagree is the day one of them is
  // quietly wrong.
  const pluginRow = stageNamed('plugin row').pattern;
  // Cheap gate on the expensive part. Resolving delegates parses a file two to
  // four times over, and 54 of the ~58 files in this tree contain no candidate
  // write at all — a file that never names a child accessor, a child table or
  // the parent accessor cannot hold a site under any shape above.
  const mentions = new RegExp(
    [...children.map((child) => child.accessor), ...children.map((child) => child.table), FK_CHILD_PARENT_ACCESSOR]
      .map((name) => name.replace(/[^A-Za-z0-9_]/g, ''))
      .join('|'),
  );

  return readShippedTree(FK_CHILD_WRITE_SCOPE)
    .filter((file) => mentions.test(file.source))
    .flatMap((file) =>
      // Delegates are resolved per FILE, because that is the scope they are
      // resolvable in: `enableHousehold` holds the plugin row through
      // `openHouseholdUnit` through `assertStillLiving`, and nothing in its own
      // text looks like a lock.
      auditedWrites(file.source, file.path, writes, claimsIncludingDelegates(file.source, file.path, pluginRow)).map(
        (site) => ({ ...site, exemption: exemptionFor(site) }),
      ),
    );
}

function exemptionFor(site: SourceSite): ClaimExemption | undefined {
  return PLUGIN_ROW_CLAIM_EXEMPTIONS.find((exemption) => {
    if (exemption.site.global || exemption.site.sticky) {
      // The last door this module left open. `test` advances `lastIndex` on
      // these, and this runs once per site — so an exemption that matched one
      // site is then judged from a non-zero offset against the next, and
      // covers a different set of sites than it reads as covering. Every other
      // pattern here is refused for exactly this; so is this one.
      throw new Error(
        `The exemption for ${exemption.file} (${exemption.enclosing}) carries a 'g' or 'y' flag on ${String(
          exemption.site,
        )}, which makes it stateful across sites. Drop the flag.`,
      );
    }

    return exemption.file === site.file && exemption.enclosing === site.enclosing && exemption.site.test(site.text);
  });
}
