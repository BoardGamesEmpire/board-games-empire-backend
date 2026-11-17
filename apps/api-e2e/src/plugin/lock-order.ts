import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ChildRelation, childRelationsOf } from '../support/schema-relations';
import {
  anyOf,
  auditedWrites,
  claimsIncludingDelegates,
  fieldNamed,
  modelWrite,
  type OrderedStage,
  relationInsert,
  relationKeyUpdate,
  relationLock,
  type SourceSite,
  type WriteShape,
} from '../support/shipped-function';
import { readShippedTree, workspaceRoot } from '../support/shipped-sql';

/**
 * The claimed total lock order of the plugin consent path, in ONE place.
 *
 * `plugin row (FOR SHARE) -> advisory key -> grant row -> unit row`, with the
 * household row ahead of all four since #548. Every writer takes a subset of
 * it in this order, and taking two of these locks in a different order than
 * another writer is a deadlock cycle — not hypothetically: the branch that
 * became #323 opened advisory-first, closing `advisory -> plugin -> grant ->
 * advisory` against the writers of the day, and it was inverted in review
 * rather than in production.
 *
 * PR #363 merged the key AFTER the grant rows, when the writer that held both
 * was a household decision. The consent act took that over (#1150) and moved
 * the key ahead of its decisions, so two acts on one unit run one after the
 * other and the later reads what the earlier wrote. That was safe to move
 * because the act is the only writer that takes both: the unit paths take the
 * key and no grant row, and the server consent act, activation, a rejected
 * update and uninstall take grant rows and no key. With nothing holding a
 * grant row while it waits for a key, no cycle runs through the pair in either
 * direction.
 *
 * The order is stated here and nowhere else, so a writer whose claim disagrees
 * with it surfaces as a red test rather than as reasoning in a PR description,
 * and a change to the order is one literal to amend (#398).
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
 * so that lock lands only once the child tuple is already written. Five tables
 * carry that FK — `plugin_grants`, `household_plugins`, `plugin_permissions`,
 * `user_plugins` and `data_gateways` (#1083) — so a write to any of the five
 * can take a plugin-row lock this constant cannot observe, in the LAST
 * position rather than the first.
 *
 * A writer whose first lock is an FK-child insert therefore takes the plugin
 * row last, after the tuple is written, and deadlocks against activation's
 * `FOR UPDATE` while every source pin stays green (#398). So every consent act —
 * household and user (#1150), and the Server unit's (#1336) — claims the
 * plugin row first, before it writes its first consent decision.
 *
 * The rule that gap left in prose is now enforced (#399): every write to an
 * FK-child table must be preceded, on every path that reaches it, by a
 * plugin-row claim, or carry an exemption that says why it needs none.
 * {@link fkChildWriteAudit} below is that check, over tables read from the
 * Prisma schema rather than from a list — a hand-kept list of them is the same
 * blind spot one level out.
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
     * The household's share lock, which a household-scope write takes first so
     * a soft-deleted household refuses it (#548). `openHouseholdUnit` and a
     * household consent act (#1150) both call `lockLiveHousehold`.
     *
     * The SQL lives in `@bge/database` (#552), outside the plugin runtime, so a
     * stage matched only by its `FOR SHARE` clause would see nothing in these
     * bodies: the call is what a body shows (#401). The SQL alternative stays,
     * for the replayed statement and for any raw copy someone writes later.
     *
     * First, and safely so. The soft-delete holds this row while it runs and
     * touches no plugin table, and so do role transitions and restore. No
     * writer of the household row takes a lock below it, so a plugin write
     * queued here holds nothing anyone is waiting for.
     */
    name: 'household row',
    pattern: anyOf(/lockLiveHousehold\(/, relationLock('households', 'FOR SHARE')),
  },
  {
    /**
     * Taken by the unit paths through `assertStillLiving`, by a consent act
     * through `claimPluginForAct` (#1150), and by uninstall and activation as
     * the claiming write they already make. All are the plugin row; what
     * matters is that nothing else is taken before it.
     *
     * The consent act's raw `FOR SHARE` lives in `claimPluginForAct`'s body,
     * not in `commit`'s, so the call is what `commit` shows — the same reason
     * the household row is matched by `lockLiveHousehold(` (#401). The FK-child
     * audit below reads this pattern too, which is how the act's grant and
     * unit writes count as claimed.
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
      /claimPluginForAct\(/,
      relationLock('plugins', 'FOR SHARE'),
      relationLock('plugins', 'FOR UPDATE'),
      /tx\.plugin\.update/,
      /plugin\.updateMany/,
    ),
  },
  {
    /**
     * The `(scopeId, pluginId)` key, which exists before the unit row does.
     * Ahead of the grant rows since #1150: a consent act takes it before its
     * decisions, so the decisions of two acts on one unit are read and written
     * one act at a time.
     */
    name: 'advisory key',
    pattern: /lock(?:Household|User)UnitScope\(|pg_advisory_xact_lock/,
  },
  {
    /**
     * The upserts of a consent act (#1150, #1336) and of an approval (#1336)
     * take it. No shipped statement takes it by raw `FOR UPDATE`; the raw
     * alternative stays for the replayed statement and for any raw lock
     * someone writes later. The pre-reads — the standing-decision `findMany`
     * in a consent act, an approval's read of the Server unit's decisions —
     * are deliberately NOT matched: they run before the upsert and lock
     * nothing, so counting them would date the stage to a read that orders
     * nothing.
     */
    name: 'grant row',
    pattern: anyOf(/pluginGrant\.upsert\(/, relationLock('plugin_grants', 'FOR UPDATE')),
  },
  {
    /**
     * The unit enablement WRITTEN through Prisma, which locks it as surely as a
     * `FOR UPDATE` would. No shipped statement locks the unit enablement by raw
     * SQL, and no plugin-wide pass writes one except uninstall's purge: a
     * unit's consent standing (#1149) and its dormancy (#1151) are worked out
     * when read, so activation and reinstall have nothing to write. The raw-SQL
     * alternative stays for the replayed statement and for any raw lock someone
     * writes later. Reads are excluded: see the note above.
     */
    name: 'unit row',
    pattern: anyOf(
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

const UNIT_LIFECYCLE = 'libs/plugin/runtime/src/lib/units/plugin-unit-lifecycle.service.ts';
const UPDATE_SERVICE = 'libs/plugin/runtime/src/lib/update/plugin-update.service.ts';
const LIFECYCLE_SERVICE = 'libs/plugin/runtime/src/lib/lifecycle/plugin-lifecycle.service.ts';
const CONSENT_ACT_SERVICE = 'libs/plugin/runtime/src/lib/consent/plugin-consent-act.service.ts';
const SERVER_CONSENT_ACT_SERVICE = 'libs/plugin/runtime/src/lib/consent/plugin-server-consent-act.service.ts';

/**
 * The installer, which takes no entry in {@link LOCK_ORDER_PATHS}.
 *
 * Named here anyway, because the FK-implied-lock audit below has an exemption
 * pointing at it — and a path spelled out inside an exemption is a path nothing
 * checks the spelling of.
 */
const INSTALLER_SERVICE = 'libs/plugin/runtime/src/lib/install/plugin-installer.service.ts';

/**
 * Where the installer places a plugin DataGateway's row (#1083), named for the
 * same reason: an exemption points at it.
 */
const PLUGIN_DATA_GATEWAY_ROW = 'libs/plugin/runtime/src/lib/install/plugin-data-gateway-row.ts';

/**
 * The function in it that places the row, by name.
 *
 * One spelling for two uses: the exemption that names it as the enclosing
 * function, and the search for its callers. Renamed in the runtime, the
 * exemption goes stale and fails, and correcting the name here corrects both.
 */
const PLACE_PLUGIN_DATA_GATEWAY_ROW = 'placePluginDataGatewayRow';

/**
 * The two files outside the plugin runtime that write an FK child (#1083):
 * the DataGateway routes' service and the interview, which both write
 * `data_gateways`. Neither takes a lock of the claimed order, so neither has
 * an entry in {@link LOCK_ORDER_PATHS}. They are named for the reason the
 * installer is: each has exemptions pointing at it.
 */
const DATA_GATEWAY_SERVICE = 'libs/api/data-gateway/src/lib/data-gateway.service.ts';
const GATEWAY_INTERVIEW_SERVICE = 'libs/gateway/driver/runtime/src/lib/gateway-interview.service.ts';

/** The files the pinned paths live in, so no spec retypes one. */
export const LOCK_SOURCES = {
  householdShareLock: 'libs/database/src/lib/utils/household-share-lock.ts',
  unitLifecycle: UNIT_LIFECYCLE,
  updateService: UPDATE_SERVICE,
  lifecycleService: LIFECYCLE_SERVICE,
  installerService: INSTALLER_SERVICE,
  consentActService: CONSENT_ACT_SERVICE,
  serverConsentActService: SERVER_CONSENT_ACT_SERVICE,
  unitScopeLock: 'libs/plugin/runtime/src/lib/grants/unit-scope-lock.ts',
  pluginDataGatewayRow: PLUGIN_DATA_GATEWAY_ROW,
  dataGatewayService: DATA_GATEWAY_SERVICE,
  gatewayInterviewService: GATEWAY_INTERVIEW_SERVICE,
} as const;

/**
 * Every writer that takes more than one of these locks.
 *
 * A path taking a single lock cannot be out of order with itself, so the list
 * is exactly the set where the claim has content. The consent act is the one
 * path that takes all five, and the only one that takes both the key and a
 * grant row: it writes household and user decisions and creates or switches
 * the unit enablement in one transaction (#1150). The server consent act
 * writes the Server unit's decisions only, so it takes the plugin-row prefix
 * and the grant row and nothing after (#1336).
 */
export const LOCK_ORDER_PATHS: readonly LockOrderPath[] = [
  {
    label: 'openHouseholdUnit (every household unit transaction)',
    file: UNIT_LIFECYCLE,
    functionName: 'openHouseholdUnit',
    stages: ['household row', 'plugin row', 'advisory key'],
    because:
      'The fused opener, so obtaining the unit row without the household row, the plugin row and the key has ' +
      'no convenient API. This is the path whose original order closed the cycle. The household row comes ' +
      'first so a soft-deleted household refuses the write (#548). It claims no unit-row lock because it ' +
      'takes none: Prisma exposes no row-lock API, and the key is what orders its read.',
  },
  {
    label: 'openUserUnit (every user unit transaction)',
    file: UNIT_LIFECYCLE,
    functionName: 'openUserUnit',
    stages: ['plugin row', 'advisory key'],
    because: 'The user-scope twin, which takes the same prefix for the same reason.',
  },
  {
    label: 'consent act (every household and user act)',
    file: CONSENT_ACT_SERVICE,
    functionName: 'commit',
    stages: ['household row', 'plugin row', 'advisory key', 'grant row', 'unit row'],
    because:
      'Every switch-on, toggle and review is one transaction through commit (#1150), so it is the one writer ' +
      'that takes all five. A household act opens with the household share lock, so a soft-deleted household ' +
      'refuses it (#548); a user act skips that stage. Then the plugin-row claim (#398), which is not optional ' +
      'decoration: the grant upserts take FOR KEY SHARE on that row through the FK anyway, AFTER writing the ' +
      'grant tuple, so without the claim this path holds the plugin row LAST and deadlocks against activation. ' +
      'The claim also compares the sha the consent surface named, so nothing judged under it is judged against ' +
      'a moved manifest (#361). Then the unit-scope key, before the act reads the unit or its decisions: two ' +
      'acts on one unit, and an act and a switch-off or config write on it, then run one after the other, so ' +
      'each judges what the one before it left (#323, #1150). Then the grant rows, in permission order, and ' +
      'last the unit enablement write. The key comes after the plugin row because a writer that waits on the ' +
      'plugin row while holding the key closes a cycle against any writer that holds the row and waits for the ' +
      'key.',
  },
  {
    label: "server consent act (a server admin's toggle and review)",
    file: SERVER_CONSENT_ACT_SERVICE,
    functionName: 'commit',
    stages: ['plugin row', 'grant row'],
    because:
      'Toggle and review are one transaction through commit (#1336). The plugin-row claim comes first for the ' +
      'FK reason the household and user act gives: the grant upserts take FOR KEY SHARE on that row AFTER ' +
      'writing the grant tuple, so without the claim this path holds the plugin row LAST and deadlocks against ' +
      'activation (#398). The claim also compares the active sha the consent surface named. Then the grant ' +
      'rows, in permission order. No household row, no advisory key and no unit enablement: the Server unit ' +
      'has none of them.',
  },
  {
    label: 'activateInTransaction (approval)',
    file: UPDATE_SERVICE,
    functionName: 'activateInTransaction',
    stages: ['plugin row', 'grant row'],
    because:
      'Activation takes the plugin row first via the `FOR UPDATE` server-config read (#370), ahead of the ' +
      'claiming write — both are the plugin row, and either dates it. Then an approval writes the Server ' +
      "unit's consent decisions through upserts, in permission order, which take the grant rows (#1336). It " +
      'takes no `FOR UPDATE` on the grants table: the plugin-row lock is what orders it against every writer ' +
      'of a server-scope decision, each of which claims that row first, so its plain read of those decisions ' +
      'is stable. It writes no unit enablement: whether a unit can run under the manifest it promotes is worked out when ' +
      'read (#1151), and so is the consent standing it announces (#1149). Its re-consent reads of the unit ' +
      'enablements write nothing and take no lock, so they are not a stage. Those unlocked reads are safe ' +
      'because every unit-enablement writer claims the plugin row before the advisory key, so a unit write ' +
      "either committed before activation's claim or waits behind it (#361). It never takes the advisory key, " +
      "which is exactly why the unit paths need the plugin row's share lock to order against it.",
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
 * A literal alone goes stale the day another child table lands, which is the
 * exact event this whole check exists for. Held against each other, a new child
 * table fails loudly and says to extend the pin.
 *
 * `data_gateways` is one of them because a plugin DataGateway's row names its
 * plugin by `pluginId` (#1083).
 */
export const FK_CHILD_TABLES = [
  'data_gateways',
  'household_plugins',
  'plugin_grants',
  'plugin_permissions',
  'user_plugins',
] as const;

/**
 * The trees scanned for writes to them: every directory that has a reason to
 * write an FK child.
 *
 * The plugin runtime entire, not only the files the pinned paths live in.
 * Scoping this to the pinned paths would inherit the blind spot it closes:
 * `plugin-installer.service.ts` writes two of these tables and has no entry in
 * {@link LOCK_ORDER_PATHS} at all — it is compliant, and nothing here would
 * have said so.
 *
 * And the two libraries that write `data_gateways` (#1083). It is the one
 * child that anything outside the plugin runtime writes, because most of its
 * rows belong to no plugin: a remote DataGateway's row has a null key, the
 * DataGateway routes create and edit it, and the interview stores its answers
 * on it. Those writes belong where they are, so their libraries are scanned
 * rather than carved out of {@link fkChildWritesOutsideScope} by name. A
 * carve-out is a list of files nobody reads again, and the next write added to
 * one of them would be covered by it unseen. Scanned, every site in them is
 * enumerated in the spec, and each unclaimed one has to say why it needs no
 * plugin-row claim.
 *
 * A list of directories rather than their common ancestor, which is `libs`. A
 * scope is only worth having while every site in it can be written out.
 */
export const FK_CHILD_WRITE_SCOPES = [
  'libs/plugin/runtime/src/lib',
  'libs/api/data-gateway/src/lib',
  'libs/gateway/driver/runtime/src/lib',
] as const;

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
 * `withArguments` guard below. Without it every unit config write and every
 * `enabled` flip in the tree reports as an FK-child write and wants
 * an exemption saying it takes no parent lock, which is noise standing exactly
 * where a real finding would appear.
 *
 * A child DELETE takes no parent lock at all and is absent for that reason.
 *
 * The raw counterpart — `UPDATE plugin_grants SET plugin_id = …` — is matched
 * by its own shape rather than by these, since a raw statement names the mapped
 * COLUMN and no Prisma method. Note that the tree currently ships no raw child
 * write of any kind, so both raw shapes match nothing today; that is why the
 * liveness case below tests every shape against a sample rather than trusting
 * an empty result to mean a clean tree.
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
 * Two shapes.
 *
 * The first is `persist()`, twice. It reaches both writes through an `if/else`
 * that claims the plugin row on the REINSTALL arm (`plugin.updateMany`, guarded
 * on the tombstone) and creates it on the FRESH-INSTALL arm. The reinstall path
 * is ordered by the claim like every other writer; the fresh path holds no lock
 * and cannot need one.
 *
 * Note what is NOT done here: `tx.plugin.create` is not added to the
 * `'plugin row'` stage pattern. A `create` on a row this transaction just
 * inserted is not the ordering claim a `FOR SHARE` is, and admitting it as one
 * would let a genuinely late claim date early somewhere else — the failure the
 * stage patterns are scoped so carefully to avoid (#399).
 *
 * And once more from a file away. `placePluginDataGatewayRow` holds the one
 * write in the tree that sets `data_gateways.plugin_id` (#1083), so it takes
 * the implied lock like any other child insert. `persist()` calls it below that
 * `if/else`, so the same two arms answer for it. `activateInTransaction()`
 * calls it too, for an update that makes the plugin a data-gateway plugin,
 * below the `FOR UPDATE` on the plugin row that every activation starts with.
 * The audit cannot see either: it judges a write inside the function that
 * holds it and resolves a delegate within one file, so where it reads there is
 * no claim. That exemption rests on its callers, and
 * {@link pluginDataGatewayRowPlacements} is what holds each caller to it.
 *
 * The second is a write to `data_gateways` that cannot set its key (#1083).
 * That table differs from the other four in the one way that matters here:
 * `pluginId` is nullable, and null on every remote DataGateway's row. Postgres
 * checks the key against `plugins`, and takes the lock this audit is about,
 * only where there is a key to check: an INSERT whose key is set, or an UPDATE
 * that leaves it set and either changes it or rewrites a row its own
 * transaction inserted. A write that leaves the key alone on a row some earlier
 * transaction committed therefore takes no plugin-row lock at all, and there is
 * nothing for a claim to order. The DataGateway routes and the interview make
 * such writes. The audit reports them because their payloads are a spread or a
 * name, which it rightly refuses to read, so each exemption says where the
 * payload comes from instead.
 *
 * What is NOT done here either: the scan is not taught that a nullable key is
 * safe. Nullable describes the column, and whether a write sets the key
 * describes the write. A rule that cleared the table would clear, along with
 * these, the one write that does set it.
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
  {
    file: PLUGIN_DATA_GATEWAY_ROW,
    enclosing: PLACE_PLUGIN_DATA_GATEWAY_ROW,
    site: /dataGateway\.create\(/,
    because:
      "Creates a plugin DataGateway's row, with the one write that sets the key, so its FK check does lock the " +
      'plugin row. Each of its two callers holds that row first, in the same transaction. persist() calls it ' +
      'below the if/else that creates the plugin row on a fresh install (a tuple no other transaction can see ' +
      'or queue behind) and claims it on a reinstall, through the plugin.updateMany that matches the plugin ' +
      'row only while it is uninstalled: the two arms the two exemptions above rest on. ' +
      'activateInTransaction() calls it for an update that makes the plugin a data-gateway plugin, below the ' +
      'FOR UPDATE on the plugin row and the claim that every activation starts with. The audit stops at the ' +
      'file boundary and cannot see a caller, so the spec pins both through pluginDataGatewayRowPlacements ' +
      '(#1083).',
  },
  {
    file: DATA_GATEWAY_SERVICE,
    enclosing: 'create',
    site: /dataGateway\.create\(/,
    because:
      'Creates a remote DataGateway, whose pluginId is null, and Postgres checks a foreign key on INSERT only ' +
      'when the key is set: no plugin row is read, so none is locked. The payload spreads CreateDataGatewayDto, ' +
      "which declares no pluginId, and the api's validation pipe refuses a body carrying a property its DTO " +
      'does not declare (whitelist with forbidNonWhitelisted), so the route, the only caller of this write, ' +
      'cannot be handed one (#1083).',
  },
  {
    file: DATA_GATEWAY_SERVICE,
    enclosing: 'update',
    site: /dataGateway\.update\(/,
    because:
      'Edits a DataGateway of either kind and cannot name the key: the payload is built from ' +
      'UpdateDataGatewayDto, the partial of the create DTO plus disabledCapabilities, behind the same ' +
      'validation pipe, and the enable and disable routes pass `enabled` alone. So a remote DataGateway keeps ' +
      'its null pluginId and a plugin DataGateway keeps the one its install wrote. Postgres checks a foreign ' +
      "key again on UPDATE only when the key changes or the row is the same transaction's insert, and this " +
      'statement runs in no transaction but its own, so it takes no plugin-row lock. Reported because the ' +
      'payload spreads, which the audit cannot read (#1083).',
  },
  {
    file: GATEWAY_INTERVIEW_SERVICE,
    enclosing: 'storeOver',
    site: /dataGateway\.updateMany\(/,
    because:
      "The interview stores a DataGateway's answers on its row, whichever kind it is, and never the key: the " +
      "payload is an InterviewData, which is Prisma's DataGatewayUpdateManyMutationInput, a type with no " +
      "pluginId in it, filled from the answers and the interview's own times. The key is left as it was, by a " +
      'statement that runs in no transaction but its own, so Postgres does not check it again and no plugin ' +
      'row is locked. Reported because the payload is passed by name, which the audit cannot read (#1083).',
  },
];

/** One FK-child write the scan found, with the exemption covering it if any. */
export interface AuditedFkChildWrite extends SourceSite {
  readonly exemption: ClaimExemption | undefined;
}

let audited: readonly AuditedFkChildWrite[] | undefined;

/**
 * Every FK-child write in {@link FK_CHILD_WRITE_SCOPES}, audited.
 *
 * Computed on first ask and kept, rather than at module load. Three other specs
 * import this module for `LOCK_SOURCES` alone, and the scan parses every scope
 * whole and can REFUSE — an unreadable schema, a child with no `@@map`.
 * At module load that refusal lands as an import error in a spec that never
 * asked, naming neither the check nor the reason; here it lands inside the case
 * that wanted the answer.
 */
export function fkChildWriteAudit(): readonly AuditedFkChildWrite[] {
  audited ??= auditFkChildWrites();

  return audited;
}

/**
 * Every file OUTSIDE {@link FK_CHILD_WRITE_SCOPES} that holds an FK-child write.
 *
 * The audit reads a short list of directories, which is the same hand-scoping
 * the derived table list exists to refuse, one level further out. A child write
 * added in another library, in the app, or in a scanned library above `src/lib`
 * takes the same implied lock, deadlocks the same way, and every case in the
 * suite stays green. So the scope is not asserted to be the right one; it is
 * asserted to be ALL of them.
 *
 * Candidates are found by grep and judged by the SHAPES, never by a second and
 * coarser pattern written for this check alone. A hand-written twin looks for
 * less than the audit does, and did: naming the child accessors and the child
 * tables, it could not see the nested write through the parent
 * (`plugin.update({ data: { grants: { create … } } })`), which names neither —
 * and being line-oriented it could not see a wrapped chain either. Grep's only
 * job here is to narrow the tree to the files worth parsing.
 */
export function fkChildWritesOutsideScope(): readonly string[] {
  const children = childRelationsOf(FK_CHILD_PARENT);
  const writes = fkChildWriteShapes(children);
  const pluginRow = stageNamed('plugin row').pattern;
  const root = workspaceRoot();
  // Identifiers alone, with no method beside them. Whether a candidate actually
  // holds a write is the shapes' question, and a grep that tried to answer it
  // would be the twin again.
  const identifiers = [
    ...children.map((child) => child.accessor),
    ...children.map((child) => child.table),
    FK_CHILD_PARENT_ACCESSOR,
  ].map((name) => name.replace(/[^A-Za-z0-9_]/g, ''));

  return shippedFilesNaming(identifiers)
    .filter((path) => !FK_CHILD_WRITE_SCOPES.some((scope) => path.startsWith(`${scope}/`)))
    .filter((path) => auditedWrites(readFileSync(join(root, path), 'utf8'), path, writes, pluginRow).length > 0);
}

/**
 * Every call to `placePluginDataGatewayRow` in the shipped tree, each marked
 * with whether the plugin row is already held on every path that reaches it
 * (#1083).
 *
 * This is the half of that function's exemption the audit cannot check. The
 * write inside it is safe because of where it is CALLED, and the audit never
 * looks there: it judges a write within the function that holds it, and
 * credits a delegate within one file (`unconditionalClaimants` says why that
 * boundary fails conservatively). Following a call across modules for one site
 * would be a new analysis. Reading the caller with the reader that already
 * exists is not.
 *
 * The call is the shape, because the call is what a caller shows of the
 * write — the reason the `'household row'` stage matches `lockLiveHousehold(`.
 * `claimed` then means what it means everywhere else here: the pattern runs on
 * every path to the site, both arms of an `if` or neither.
 *
 * The pattern is the `'plugin row'` stage's own, plus `tx.plugin.create`. That
 * create stays out of the stage, as {@link PLUGIN_ROW_CLAIM_EXEMPTIONS} says it
 * must: the stage asks whether a path queues at the plugin row, and a create
 * queues behind nothing. The question here is a different one — whether the
 * transaction already holds the plugin row when it places the plugin's
 * DataGateway row — and on a fresh install it holds the plugin row by having
 * made it.
 *
 * Callers are found by NAME over the whole shipped tree, not the scanned
 * scope, since a call from anywhere is a caller the exemption has to answer
 * for. What this cannot see is the function handed on as a value and called
 * under another name. No call in this tree is made that way, and a reader
 * adding the first one should widen this rather than trust it.
 */
export function pluginDataGatewayRowPlacements(): readonly SourceSite[] {
  const root = workspaceRoot();
  const placed: WriteShape = { pattern: new RegExp(String.raw`(?:^|\.)\s*${PLACE_PLUGIN_DATA_GATEWAY_ROW}$`) };
  const pluginRowHeld = anyOf(stageNamed('plugin row').pattern, /tx\.plugin\.create\(/);

  return shippedFilesNaming([PLACE_PLUGIN_DATA_GATEWAY_ROW]).flatMap((path) =>
    auditedWrites(readFileSync(join(root, path), 'utf8'), path, [placed], pluginRowHeld),
  );
}

/**
 * The shipped `.ts` files naming any of the given identifiers,
 * workspace-relative: the candidates, for the caller to parse and judge.
 *
 * Naming nothing is an error here, not an empty list: `git grep` exits
 * non-zero when no file matches, and that is left to throw. Both callers ask
 * about names the tree is expected to spell, so an empty answer means a
 * renamed identifier, and returned quietly it would read as a clean tree.
 *
 * "Shipped" leaves out specs and every e2e project, this one included (#1083).
 * No e2e project is built into an image or run by the server: each is a test
 * harness that seeds its own database through Prisma, writing plugin rows and
 * their children directly because no running server is there to do it. Those
 * writes take part in no lock order a server takes, so holding them to one
 * would only make every new e2e project's seeding fail an audit about
 * something else.
 */
function shippedFilesNaming(identifiers: readonly string[]): readonly string[] {
  // `execFileSync` with an argument array: the pattern is built from
  // identifiers rather than typed here, and a shell would give those a second
  // meaning.
  const found = execFileSync(
    'git',
    [
      'grep',
      '-lE',
      // Untracked files count. A write or a call added in a file nobody has
      // committed yet is exactly what this is asked to find, and `git grep`
      // reads the index by default — so without this a check passes on the
      // change that introduces the problem and fails on the commit after it.
      // Ignored paths stay excluded, so `node_modules` is not walked.
      '--untracked',
      `(^|[^A-Za-z0-9_])(${identifiers.join('|')})($|[^A-Za-z0-9_])`,
      '--',
      '*.ts',
      ':!*.spec.ts',
      // Every e2e project, the next one too, by the `-e2e` suffix each of them
      // carries. Without the `:(glob)` magic a pathspec's `*` also matches `/`,
      // so this reaches every file under each such app, however deep.
      ':!apps/*-e2e/*',
    ],
    { cwd: workspaceRoot(), encoding: 'utf8' },
  );

  return found.split('\n').filter((path) => path.length > 0);
}

/**
 * The write shapes, one per way a child row can be inserted or re-parented.
 *
 * Built from the schema so the accessor, the table, the FK field and the mapped
 * column of each child always agree with each other. Each re-parent shape is
 * paired with ITS OWN foreign key rather than a pooled guard over all five:
 * pooling emits the same alternative five times today, and the day one child
 * keys differently it would count a write of another child's column as a
 * re-parent, producing a site whose exemption could only say "that is not this
 * table's key".
 */
export function fkChildWriteShapes(children: readonly ChildRelation[]): readonly WriteShape[] {
  const accessors = children.map((child) => child.accessor);

  return [
    { pattern: modelWrite(accessors, [...FK_CHILD_INSERT_METHODS]) },
    { pattern: relationInsert(children.map((child) => child.table)) },
    // The raw re-parent, paired table-to-column for the same reason the Prisma
    // re-parent shapes are paired field-to-accessor: pooled, a statement
    // writing one child's key column would count as a re-parent of another
    // child's table, and the site it produced could only be explained by
    // saying it was the wrong table.
    ...children.map((child) => ({ pattern: relationKeyUpdate(child.table, child.column) })),
    ...children.map((child) => ({
      pattern: modelWrite([child.accessor], [...FK_CHILD_REPARENT_METHODS]),
      withArguments: fieldNamed([child.foreignKey]),
      // `data`, not the whole call. The installer's switch of a plugin's
      // DataGateway row (`placePluginDataGatewayRow`) is addressed by its
      // plugin, so `where` names `pluginId` while `data` rewrites only
      // `enabled` — a guard over the whole call reports it, and would report
      // every child update addressed by its plugin with it.
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
  refuseStatefulExemptions();

  const children = childRelationsOf(FK_CHILD_PARENT);
  const writes = fkChildWriteShapes(children);
  // The stage's own pattern, not a second copy of it. A hand-written twin is
  // how the plugin row would come to mean one thing to the order pins and
  // another to this check, and the day they disagree is the day one of them is
  // quietly wrong.
  const pluginRow = stageNamed('plugin row').pattern;
  // Cheap gate on the expensive part. Resolving delegates parses a file two to
  // four times over, and nearly every file in these trees contains no candidate
  // write at all — a file that never names a child accessor, a child table or
  // the parent accessor cannot hold a site under any shape above.
  const mentions = new RegExp(
    [...children.map((child) => child.accessor), ...children.map((child) => child.table), FK_CHILD_PARENT_ACCESSOR]
      .map((name) => name.replace(/[^A-Za-z0-9_]/g, ''))
      .join('|'),
  );

  // Each scope is read on its own, so each keeps `readShippedTree`'s refusal:
  // a library that moved fails by name instead of dropping out of the scan.
  return FK_CHILD_WRITE_SCOPES.flatMap((scope) => readShippedTree(scope))
    .filter((file) => mentions.test(file.source))
    .flatMap((file) =>
      // Delegates are resolved per FILE, because that is the scope they are
      // resolvable in: `updateHouseholdConfig` holds the plugin row through
      // `openHouseholdUnit` through `assertStillLiving`, and nothing in its own
      // text looks like a lock.
      auditedWrites(file.source, file.path, writes, claimsIncludingDelegates(file.source, file.path, pluginRow)).map(
        (site) => ({ ...site, exemption: exemptionFor(site) }),
      ),
    );
}

/**
 * Refuses a stateful exemption pattern, over the WHOLE list and before any site
 * is matched.
 *
 * `test` advances `lastIndex` on a `g` or `y` pattern, and `exemptionFor` runs
 * once per site — so an exemption that matched one site is judged from a
 * non-zero offset against the next, and covers a different set than it reads as
 * covering. Every other pattern in this module is refused for exactly that.
 *
 * Checked here rather than inside the `find` predicate, which was the earlier
 * shape: `find` stops at its first match, so a later exemption's flags were
 * examined only when an earlier one happened not to match. Validation that
 * depends on list order and on which sites the audit happens to find is not
 * validation.
 */
function refuseStatefulExemptions(): void {
  for (const exemption of PLUGIN_ROW_CLAIM_EXEMPTIONS) {
    if (exemption.site.global || exemption.site.sticky) {
      throw new Error(
        `The exemption for ${exemption.file} (${exemption.enclosing}) carries a 'g' or 'y' flag on ${String(
          exemption.site,
        )}, which makes it stateful across sites. Drop the flag.`,
      );
    }
  }
}

function exemptionFor(site: SourceSite): ClaimExemption | undefined {
  return PLUGIN_ROW_CLAIM_EXEMPTIONS.find(
    (exemption) =>
      exemption.file === site.file && exemption.enclosing === site.enclosing && exemption.site.test(site.text),
  );
}
