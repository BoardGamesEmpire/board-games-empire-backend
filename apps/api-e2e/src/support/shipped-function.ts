import ts from 'typescript';
import { readShippedSource } from './shipped-sql';

/**
 * Lifts a FUNCTION BODY out of application source, and checks the order things
 * happen inside it.
 *
 * `shipped-sql.ts` lifts everything a template can express. A lock ORDER is not
 * one of those things: it lives in the sequence of calls a function makes, and
 * no statement carries it. The claim this suite pins — plugin row, then grant
 * row, then advisory key, then unit row (#323, PR #363) — is therefore only
 * observable in the source text, the same way `QuotaService`'s digest recipe
 * was (`readShippedSource`).
 *
 * Why pin it at all: a barrier can show that a given order queues safely and
 * that the reverse deadlocks, but neither says which order the application
 * takes. Ship the barrier alone and the specs keep passing over a service that
 * reordered its locks — the cycle that reached review on #323's branch,
 * exactly. Ship the pin alone and the order is proven WRITTEN, not proven SAFE.
 * Both, or neither is worth much (#360).
 *
 * ## Why the TypeScript compiler, and not a brace matcher
 *
 * The first version of this module hand-rolled one. It was wrong in three ways
 * that all produced a WRONG BODY rather than an error — a return type carrying
 * its own braces, a signature with no trailing semicolon walking out of its
 * enclosing block, and a regex literal containing a brace shifting the depth so
 * the lift swallowed the next function whole. A module whose only job is to
 * refuse when it is unsure cannot have silent failure modes of its own, and
 * `typescript` is already a dependency of this workspace. So the declaration is
 * found by walking the AST, which is right by construction for every shape
 * TypeScript can parse.
 *
 * Comments are blanked before anything is matched, and that is load-bearing
 * rather than tidy: these services discuss their own lock order in prose above
 * the code that takes it (`plugin-grant.service.ts` mentions `FOR UPDATE` and
 * `lockUserUnitScope` in comments), so a matcher that read comments would pin
 * the order of the documentation.
 */

/** A function lifted from source. */
export interface ShippedFunction {
  readonly name: string;

  /** The text between the body's braces, with comments blanked to spaces. */
  readonly body: string;
}

/** One step of an order claim: what to call it, and how to recognise it. */
export interface OrderedStage {
  readonly name: string;
  readonly pattern: RegExp;
}

/** The four row-lock modes Postgres has. A stage is recognised by exactly one. */
export type RowLockMode = 'FOR UPDATE' | 'FOR NO KEY UPDATE' | 'FOR SHARE' | 'FOR KEY SHARE';

/**
 * Where a relation name is allowed to end.
 *
 * Not `\b`, which ends the name at any non-word character — and two of those
 * are still INSIDE a Postgres relation reference. `$` is a legal identifier
 * character, so `plugins$archive` would pass as `plugins`; a trailing `.` makes
 * the name a SCHEMA, so `plugins.audit` is a lock on some other table wearing
 * this one's name.
 *
 * Not an enumeration of the delimiters that may follow, either. Listing `\s`,
 * `,`, `;` and the comment openers rejects valid syntax nobody listed — a
 * subquery's `FROM plugins)` among them. Saying the identifier ENDS here covers
 * the forms without having to have thought of them.
 */
const RELATION_END = '(?![\\w$.])';

const SAFE_RELATION = /^[a-z_][a-z0-9_]*$/i;

/**
 * A pattern matching a row lock taken on the given relation by raw SQL.
 *
 * The boundary rule lives HERE rather than in each stage that needs it. Three
 * hand-written copies is how it got tightened three times in review and had to
 * be corrected in three places each time — and the copy nobody looked at is the
 * one that stays loose, which for an order claim is not a near miss. Order is
 * judged by FIRST occurrence, so a pattern matching something it did not mean
 * dates the stage to the wrong statement, and a lock genuinely taken later
 * reports as held early.
 *
 * The mode is matched literally and needs no boundary of its own: no Postgres
 * lock mode contains another as a substring — `FOR KEY SHARE` notably does not
 * contain `FOR SHARE` — so the four are already mutually exclusive.
 */
export function relationLock(relations: string | readonly string[], mode: RowLockMode): RegExp {
  return new RegExp(`FROM ${relationAlternation(relations, `${mode} stage`)}${RELATION_END}[^\`]*?${mode}`);
}

/**
 * One stage pattern from several alternatives, so a stage recognised more than
 * one way still states each way as its own readable pattern.
 *
 * Flags are refused rather than dropped. `g` and `y` make `test` stateful, and
 * a stage pattern is tested against many bodies — every second one would report
 * false, which is a silent pass rather than a visible failure.
 *
 * An empty list is refused for a worse version of the same reason. Joining
 * nothing gives `/(?:)/`, which matches at offset 0 of every body — so the
 * stage is never reported missing AND always sorts before every real one. Both
 * halves of the order check pass, and a path that stopped taking the lock reads
 * as taking it first.
 */
export function anyOf(...alternatives: readonly RegExp[]): RegExp {
  if (alternatives.length === 0) {
    throw new Error('A stage pattern combining no alternatives matches every body at offset 0; give it one.');
  }

  const flagged = alternatives.filter((alternative) => alternative.flags !== '');

  if (flagged.length > 0) {
    throw new Error(
      `Alternatives carry flags (${flagged.map(String).join(', ')}), which combining would drop. State a stage ` +
        `pattern without them.`,
    );
  }

  return new RegExp(alternatives.map((alternative) => alternative.source).join('|'));
}

/**
 * Replaces every comment with spaces, preserving length and therefore every
 * offset into the source.
 *
 * String and template contents are KEPT: a lifted body has to carry its SQL,
 * because a locking clause inside a template literal is one of the things an
 * order claim is recognised by.
 */
export function blankComments(source: string): string {
  return blankCommentRanges(source, parse(source, 'source.ts'));
}

/**
 * Lifts the body of the named function.
 *
 * The name must resolve to a DECLARATION with a body — a method, a function, or
 * a name bound to a function or arrow expression. A prose mention or a call
 * site is not one, and resolving to the next function's body would pin a
 * different path's order under this path's name, which is the silent wrong
 * answer this module exists to avoid.
 */
export function extractFunctionBody(source: string, functionName: string, sourceLabel: string): ShippedFunction {
  const file = parse(source, sourceLabel);
  const body = singleDeclaredBody(file, functionName, sourceLabel);
  const blanked = blankCommentRanges(source, file);

  // `getStart` is the `{`; `end` is one past the `}`.
  return { name: functionName, body: blanked.slice(body.getStart(file) + 1, body.end - 1) };
}

/** {@link extractFunctionBody} against a workspace-relative source file. */
export function readShippedFunction(relativePath: string, functionName: string): ShippedFunction {
  return extractFunctionBody(readShippedSource(relativePath), functionName, relativePath);
}

/**
 * Lifts ONE conditional branch out of a function, identified by what its
 * condition tests.
 *
 * A function with two independent branches cannot be pinned as one body. Order
 * is judged by first occurrence, so the earlier branch's stages date the later
 * branch's claim: `decide()` reaches its required-denial mirror long before its
 * granted-user anchor, and an anchor created BEFORE the key it is supposed to
 * sit behind still leaves the whole-body pin green — which is an
 * advisory-after-unit inversion, and the shape that deadlocks against the
 * mirror pass taking those two the other way round.
 *
 * The branch is named by its CONDITION rather than by its contents, which is
 * what keeps this from being circular: matching on the lock it takes would make
 * the pin agree with whatever it found.
 */
export function extractBranchBody(
  source: string,
  functionName: string,
  condition: RegExp,
  sourceLabel: string,
): ShippedFunction {
  if (condition.global || condition.sticky) {
    // `test` advances `lastIndex` on these, so consecutive matches alternate
    // true, false, true. Two branches testing the same condition would then
    // look like one and this pin would take the FIRST without ever reaching
    // the ambiguity refusal below — the exact silent answer the refusals exist
    // to prevent, arriving through the flag rather than through the source.
    throw new Error(
      `The branch condition ${String(condition)} carries a 'g' or 'y' flag, and this pin tests it once per ` +
        `\`if\`. A stateful pattern makes every second match report false, which turns an ambiguous branch ` +
        `into a silently chosen one. Drop the flag.`,
    );
  }

  const file = parse(source, sourceLabel);
  // The same refusals, for the same reasons: a name that resolves to nothing,
  // or to more than one body, is not a branch this pin can be about.
  const enclosing = singleDeclaredBody(file, functionName, sourceLabel);
  const blanked = blankCommentRanges(source, file);
  const branches: ts.Statement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && condition.test(blanked.slice(node.expression.getStart(file), node.expression.end))) {
      branches.push(node.thenStatement);
    }

    ts.forEachChild(node, visit);
  };

  visit(enclosing);

  const branch = branches[0];

  if (branch === undefined) {
    throw new Error(
      `No branch of '${functionName}' in ${sourceLabel} tests ${String(condition)}. The condition is how this ` +
        `pin names the branch — if the branch was restructured, the pin has to be restated deliberately rather ` +
        `than quietly matching a neighbour.`,
    );
  }

  if (branches.length > 1) {
    throw new Error(
      `${branches.length} branches of '${functionName}' in ${sourceLabel} test ${String(condition)}, so this ` +
        `pin cannot say which one it means. Tighten the condition pattern.`,
    );
  }

  return { name: `${functionName} [${String(condition)}]`, body: blanked.slice(branch.getStart(file), branch.end) };
}

/** {@link extractBranchBody} against a workspace-relative source file. */
export function readShippedBranch(relativePath: string, functionName: string, condition: RegExp): ShippedFunction {
  return extractBranchBody(readShippedSource(relativePath), functionName, condition, relativePath);
}

/**
 * Checks that a body takes EVERY stage the caller claims for it, in the claimed
 * order, returning a failure message or `undefined`.
 *
 * Every claimed stage must match. The looser rule — skip the absent ones and
 * order the rest — is the version this module shipped first, and it was quietly
 * useless: a path claiming two stages that lost one to a rename matched a
 * single stage, the comparison loop never ran, and the pin returned "in order"
 * while asserting nothing. Most paths pinned here claim exactly two stages, so
 * every one of them was one rename away from being a no-op. Which stages a path
 * takes is a claim in its own right, so a stage that stops matching fails
 * whether it moved or vanished.
 *
 * Order is judged by FIRST occurrence: a path that takes a lock early and
 * mentions it again later has already taken it early, and judging by the last
 * occurrence would let a reordering hide behind a re-read.
 */
export function orderMismatch(body: string, stages: readonly OrderedStage[], pathLabel: string): string | undefined {
  const found = stages.map((stage) => ({ stage, at: body.search(stage.pattern) }));
  const missing = found.filter((candidate) => candidate.at < 0);

  if (missing.length > 0) {
    return (
      `${pathLabel} no longer takes ${missing.map((candidate) => `'${candidate.stage.name}'`).join(', ')}. ` +
      `Either the path stopped taking it, or a helper was renamed and the stage pattern no longer recognises ` +
      `it — the second reads as harmless and is not, because an unrecognised stage cannot be ordered against ` +
      `anything. Claimed: ${stages.map((stage) => stage.name).join(' -> ')}.`
    );
  }

  for (let index = 1; index < found.length; index += 1) {
    const previous = found[index - 1];
    const current = found[index];

    if (previous !== undefined && current !== undefined && previous.at > current.at) {
      return (
        `${pathLabel} takes '${current.stage.name}' before '${previous.stage.name}', but the claimed order is ` +
        `${stages.map((stage) => stage.name).join(' -> ')}. Two paths taking these locks in different orders ` +
        `is a deadlock cycle — the one inverted in review on #323's branch was exactly this shape. If the ` +
        `order genuinely changed, change the claim in one place and let every path be re-judged against it.`
      );
    }
  }

  return undefined;
}

function parse(source: string, sourceLabel: string): ts.SourceFile {
  return ts.createSourceFile(sourceLabel, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
}

/**
 * Every body declared under the given name.
 *
 * Methods, function declarations, and names bound to a function or arrow
 * expression all count; an interface member, an abstract signature and an
 * overload declaration do not, because they have no body to lift. Returning
 * ALL of them rather than the first is what lets the caller refuse an ambiguous
 * name instead of silently taking one.
 */
function declaredBodies(file: ts.SourceFile, functionName: string): ts.Block[] {
  const bodies: ts.Block[] = [];

  const visit = (node: ts.Node): void => {
    const body = bodyOfDeclaration(node, functionName);

    if (body !== undefined) {
      bodies.push(body);
    }

    ts.forEachChild(node, visit);
  };

  visit(file);

  return bodies;
}

/**
 * The one body declared under the given name, or a refusal saying which way it
 * was ambiguous.
 *
 * Both lifters go through here rather than one calling the other for its
 * throw. A refusal reached as a SIDE EFFECT is a refusal the typechecker
 * cannot see: the caller still holds a possibly-undefined body afterwards, and
 * the cast that silences it is what would turn this module's deliberate
 * message into a `TypeError` the day the shape changed.
 */
function singleDeclaredBody(file: ts.SourceFile, functionName: string, sourceLabel: string): ts.Block {
  const bodies = declaredBodies(file, functionName);
  const body = bodies[0];

  if (body === undefined) {
    throw new Error(
      `Could not find a declaration of '${functionName}' in ${sourceLabel}. A mention in prose or a call site ` +
        `is not a declaration — if the function was renamed, rename the pin with it rather than letting it ` +
        `resolve to a neighbour.`,
    );
  }

  if (bodies.length > 1) {
    // Two classes in one file, or a name reused. Guessing which one the caller
    // meant is exactly the judgement this module refuses to make.
    throw new Error(
      `'${functionName}' is declared ${bodies.length} times with a body in ${sourceLabel}, so this pin cannot ` +
        `say which one it means. Give the declarations distinct names, or pin them where they are distinct.`,
    );
  }

  return body;
}

function bodyOfDeclaration(node: ts.Node, functionName: string): ts.Block | undefined {
  if (
    (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
    node.name !== undefined &&
    ts.isIdentifier(node.name) &&
    node.name.text === functionName
  ) {
    return node.body !== undefined && ts.isBlock(node.body) ? node.body : undefined;
  }

  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === functionName) {
    const initializer = node.initializer;

    if (
      initializer !== undefined &&
      (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
      ts.isBlock(initializer.body)
    ) {
      return initializer.body;
    }
  }

  return undefined;
}

/**
 * Blanks every comment in the file, keeping offsets.
 *
 * Comment ranges come from the compiler rather than from a `//` scan, so a
 * comment marker inside a string, a template, or a regular expression is left
 * alone — the case the hand-rolled version got wrong in both directions.
 *
 * The walk descends through TOKENS (`getChildren`), not just nodes. A comment
 * is trivia attached to the token that follows it, and some of those tokens are
 * not nodes: a note sitting alone before a block's closing brace belongs to the
 * `}`, and an empty function's entire body is trivia between two braces. A
 * node-only walk left both of them in the text, which is worse than useless
 * here — a comment mentioning `suspendHouseholdUnit` would SUPPLY the match for
 * a stage the path had stopped taking, and the pin would answer "in order"
 * about a body it had only read prose in.
 */
function blankCommentRanges(source: string, file: ts.SourceFile): string {
  const characters = source.split('');
  const blank = (pos: number, end: number): void => {
    for (let at = pos; at < end && at < characters.length; at += 1) {
      if (characters[at] !== '\n') {
        characters[at] = ' ';
      }
    }
  };

  const visit = (node: ts.Node): void => {
    ts.forEachLeadingCommentRange(source, node.getFullStart(), blank);
    ts.forEachTrailingCommentRange(source, node.end, blank);

    for (const child of node.getChildren(file)) {
      visit(child);
    }
  };

  visit(file);

  return characters.join('');
}

/**
 * ## Locks nobody wrote: claim dominance (#399)
 *
 * Everything above reads what the source SAYS. The rest of this module exists
 * because Postgres also takes locks nobody wrote: an INSERT into a table with
 * an FK takes `FOR KEY SHARE` on the parent row from the referential-integrity
 * trigger, and RI checks are AFTER ROW triggers, so that lock lands only once
 * the child tuple is written. `decide()` deadlocked on exactly that for as long
 * as it existed, with the order pins above green the whole time (#398).
 *
 * The check that closes it is not another stage. A stage is a FIRST OCCURRENCE
 * in a body, and the implied lock's honest position is *after* the write, which
 * `orderMismatch` has no way to express. So the requirement is asserted
 * directly instead: a writer of an FK-child table must take the parent lock on
 * every path that reaches the write.
 *
 * ## Why dominance, and not "the pattern appears earlier"
 *
 * First occurrence is the weaker reading, and it is wrong here in a way that
 * matters. `plugin-installer.service.ts` claims the plugin row in ONE branch of
 * an `if/else` — the reinstall branch's `plugin.updateMany` — and writes two
 * FK-child tables after the branch closes. A first-occurrence check finds that
 * claim earlier in the text and passes, having proved nothing about the other
 * branch, which is the branch with no lock in it. That is the same silent pass
 * `LockOrderPath.branch` exists to close one level up.
 *
 * So a claim counts only where it runs on EVERY path to the write: both arms of
 * an `if` or neither, and never a loop body, which may run zero times. Failing
 * conservatively is the point — a false failure is one comment away from being
 * an exemption that states why a site is safe, and a false pass is what #398
 * shipped.
 */

/** One site the scan found, and enough context to act on it. */
export interface SourceSite {
  /** Workspace-relative, as the caller labelled it. */
  readonly file: string;

  /** 1-based, so it pastes into an editor. */
  readonly line: number;

  /** The nearest named function around it, for the failure message. */
  readonly enclosing: string;

  /** The matched text, trimmed to one line — enough to recognise the site. */
  readonly text: string;

  /** Whether a claim runs on every path that reaches it. */
  readonly claimed: boolean;
}

/** One shape of write the scan looks for. */
export interface WriteShape {
  /** Matched against a call's CALLEE, or a tagged template's whole text. */
  readonly pattern: RegExp;

  /**
   * An extra condition on the call's ARGUMENTS, when the callee alone does not
   * settle it.
   *
   * The update forms need this and the insert forms do not. Postgres skips the
   * referential-integrity check on an UPDATE whose key columns are unchanged,
   * so `pluginGrant.update` takes the implied parent lock only when it writes
   * the FK column — and matching every child update would report six sites that
   * take no parent lock at all, each of them wanting an exemption that says
   * nothing.
   */
  readonly withArguments?: RegExp;

  /**
   * Narrows {@link withArguments} to one property of the call's first object
   * argument.
   *
   * Needed because the whole-argument text answers the wrong question. A Prisma
   * update addressed by its compound unique key names the FK column in `where`
   * — activation's grant re-stamp does exactly this — so a guard over the whole
   * call reports every keyed child update as a re-parenting one, which is every
   * child update there is.
   *
   * A payload this cannot ENUMERATE is reported rather than skipped — the
   * argument is not an object literal, the property is shorthand or absent, or
   * its value is a name rather than a literal. The guard settles a site only
   * when it can see the whole set of keys and the FK is not among them.
   *
   * A spread counts as unreadable, so `data: { ...payload, enabled: true }` is
   * REPORTED. That is the two config/dormancy updates this tree already makes,
   * and both are pinned in the audit — they carry a dominating claim, so
   * reporting them costs an enumeration entry rather than an exemption. The
   * cheaper reading, judging such a literal on its visible text, cannot see
   * what `...payload` contributes, and the point of a narrowing guard is that
   * it clears a site only when it has seen every key.
   *
   * The barrier cases remain what actually holds the order.
   */
  readonly argumentProperty?: string;
}

/**
 * Every site matching one of `writes`, each marked with whether `claims`
 * precedes it on every path through its innermost enclosing function.
 *
 * Returns the CLAIMED sites too, rather than only the failures. A scan that
 * silently finds nothing is this harness's characteristic failure mode — the
 * one `anyOf` refuses an empty list over, and the one the stage-recognition
 * case guards — so the caller needs the whole enumeration to hold against a
 * known set. A check that reports "no violations" because its pattern stopped
 * matching reads exactly like a check that passed.
 *
 * The innermost function is the scope because that is where a transaction
 * callback's body is: `this.db.$transaction(async (tx) => { … })` puts the
 * whole transaction in one arrow, and locks are per-transaction. Widening to
 * the enclosing METHOD would let a claim outside the callback — which is to say
 * a claim in a different transaction, or in none — answer for a write inside
 * it.
 *
 * Nested functions are masked out of the text before anything is matched, so a
 * claim inside a callback defined before the write does not count as taken:
 * whether that callback ever runs, and in which transaction, is not something a
 * reader of source can know.
 */
export function auditedWrites(
  source: string,
  sourceLabel: string,
  writes: readonly WriteShape[],
  claims: RegExp,
): readonly SourceSite[] {
  if (writes.length === 0) {
    throw new Error('A scan looking for no write shape finds nothing, which reads exactly like a clean tree.');
  }

  for (const shape of writes) {
    refuseStatefulPattern(shape.pattern, 'write');

    if (shape.withArguments !== undefined) {
      refuseStatefulPattern(shape.withArguments, 'write-argument');
    }
  }

  refuseStatefulPattern(claims, 'claim');

  const file = parse(source, sourceLabel);
  const blanked = blankCommentRanges(source, file);
  const sites: SourceSite[] = [];

  const visit = (node: ts.Node): void => {
    if (matchesWrite(node, writes, blanked, file)) {
      sites.push({
        file: sourceLabel,
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        enclosing: enclosingName(node),
        text: firstLine(blanked.slice(node.getStart(file), node.end)),
        claimed: dominatedByClaim(node, enclosingScope(node), claims, blanked, file),
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(file);

  return sites;
}

/**
 * The names of functions in this file that take `claims` on every path through
 * them — the delegates a caller is entitled to claim THROUGH.
 *
 * Without this the check reports false failures on the honest shape the unit
 * paths already use: `enableHousehold` claims the plugin row by calling
 * `openHouseholdUnit`, which claims it by calling `assertStillLiving`, which is
 * where the `FOR SHARE` is actually written. Nothing in the caller's own text
 * looks like a lock, and it is holding one.
 *
 * Derived rather than listed, because a hand-kept list of delegates is the same
 * blind spot this check is about. Same file only: resolving a delegate across
 * modules is a bigger analysis than this, and stopping at the file boundary
 * fails conservatively — an out-of-file delegate reports as unclaimed, which is
 * a red test asking for an exemption rather than a green one asserting nothing.
 *
 * A delegate is credited BY NAME, with no regard for what it is called on or
 * what it is passed. So `this.openHouseholdUnit(this.db, …)` — the
 * non-transactional client — satisfies the claim for a write that follows it
 * inside a `$transaction` callback, though the lock it took was in a different
 * transaction and released before the child write. Knowing otherwise means
 * resolving the receiver and the client binding, which is a type-checker's job,
 * not a source reader's. The barrier pair is what would catch it.
 */
export function unconditionalClaimants(source: string, sourceLabel: string, claims: RegExp): readonly string[] {
  refuseStatefulPattern(claims, 'claim');

  const file = parse(source, sourceLabel);
  const blanked = blankCommentRanges(source, file);
  const names = new Set<string>();

  const visit = (node: ts.Node): void => {
    const declared = namedFunctionBody(node);

    if (declared !== undefined && claimsOnEveryPath(declared.body, claims, blanked, file)) {
      names.add(declared.name);
    }

    ts.forEachChild(node, visit);
  };

  visit(file);

  return [...names].sort();
}

/**
 * `claims`, widened with a call to every function in the file that takes it on
 * every path, repeated until the set stops growing.
 *
 * Iterated rather than resolved one hop deep: `enableHousehold` reaches the
 * lock through two delegates, and a one-hop rule would happen to cover today's
 * tree while quietly failing the day a third link appears.
 */
export function claimsIncludingDelegates(source: string, sourceLabel: string, claims: RegExp): RegExp {
  let pattern = claims;
  let known = 0;

  // The set only ever WIDENS — each pass starts from `claims` and adds every
  // delegate the previous pass could see — so an unchanged size is an unchanged
  // set, and comparing sizes is a sound stop. Bounded anyway: a fixpoint that
  // cannot terminate is not a failure mode worth leaving open in the harness
  // whose job is to refuse when it is unsure.
  for (let pass = 0; pass < DELEGATE_PASS_LIMIT; pass += 1) {
    const delegates = unconditionalClaimants(source, sourceLabel, pattern);

    if (delegates.length === known) {
      return pattern;
    }

    known = delegates.length;
    pattern = anyOf(claims, ...delegates.map(callTo));
  }

  throw new Error(
    `Delegate resolution for ${sourceLabel} did not settle in ${DELEGATE_PASS_LIMIT} passes, so the claim ` +
      `pattern it returns is not the one a later run would compute.`,
  );
}

const DELEGATE_PASS_LIMIT = 16;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * A pattern matching a raw `INSERT INTO` against the given relations.
 *
 * Goes through the same `RELATION_END` as {@link relationLock}, and for the
 * same reason that constant exists rather than a `\b`: `INSERT INTO plugins`
 * would otherwise match `plugins_archive` and `plugins.audit`, which are other
 * tables. Keywords are matched in the case this repo writes SQL in — the same
 * assumption `relationLock` already makes of `FROM` and `FOR UPDATE`.
 */
export function relationInsert(relations: string | readonly string[]): RegExp {
  return new RegExp(String.raw`INSERT\s+INTO\s+${relationAlternation(relations, 'INSERT INTO')}${RELATION_END}`);
}

/**
 * A pattern matching a Prisma write, by client accessor and method, against the
 * CALLEE of a call — `tx.pluginGrant.upsert`, and nothing containing it.
 *
 * Anchored at both ends. Without the tail anchor `…create` also matches
 * `…createMany`, which is harmless here only because both are already listed;
 * without the head alternation a destructured client (`pluginGrant.create(…)`)
 * is missed entirely, and a missed writer is the blind spot this whole check is
 * about.
 */
export function modelWrite(accessors: readonly string[], methods: readonly string[]): RegExp {
  if (accessors.length === 0 || methods.length === 0) {
    throw new Error('A model-write pattern naming no accessor or no method matches nothing, which reports clean.');
  }

  const named = (names: readonly string[]): string =>
    names.map((name) => identifierSource(name, 'a write pattern')).join('|');

  // Whitespace around the separator, because a callee is lifted verbatim and a
  // chain may be WRAPPED: `tx.pluginGrant\n  .create(…)` reaches this as text
  // carrying the newline and the indent. Without it that write matches no
  // shape, the audit finds no site, and the tree reports clean — the silent
  // direction, again.
  return new RegExp(String.raw`(?:^|\.)\s*(?:${named(accessors)})\s*\.\s*(?:${named(methods)})$`);
}

/**
 * A pattern matching a mention of any of the given object fields.
 *
 * Used as a {@link WriteShape.withArguments} guard, where the question is
 * whether an update's payload names the FK column at all. Deliberately blunt: a
 * `data` object naming the field is treated as writing it, because narrowing
 * that to an assignment would mean parsing the object literal, and the
 * conservative direction here reports a site rather than skipping one.
 */
export function fieldNamed(fields: readonly string[]): RegExp {
  if (fields.length === 0) {
    throw new Error('A field guard naming no field matches nothing, so every write it guards is skipped.');
  }

  const named = fields.map((field) => identifierSource(field, 'a field guard')).join('|');

  return new RegExp(`${IDENTIFIER_START}(?:${named})${IDENTIFIER_END}`);
}

function relationAlternation(relations: string | readonly string[], noun: string): string {
  const names = typeof relations === 'string' ? [relations] : relations;

  if (names.length === 0) {
    throw new Error(`A pattern matching no relation matches every ${noun} in the body; name the table.`);
  }

  for (const name of names) {
    if (!SAFE_RELATION.test(name)) {
      throw new Error(
        `'${name}' is not a plain relation name. This builds a regex, so anything else changes what the pattern ` +
          `matches instead of failing.`,
      );
    }
  }

  return names.length > 1 ? `(?:${names.join('|')})` : names.join('|');
}

/**
 * Where an identifier is allowed to begin and end.
 *
 * `\b` is wrong at both ends, and wrong in the direction that fails SILENTLY. A
 * JavaScript identifier may contain `$`, which is not a word character — so
 * `\b` in front of `$claimPluginRow` demands a word character before the `$`,
 * and `this.$claimPluginRow(` (a `.` in front) never matches. The delegate is
 * dropped without a word, and this module's contract is that what it cannot see
 * is what it refuses over, not what it skips. Prisma's own surface is full of
 * `$`-prefixed names, so this is the repo's spelling, not a hypothetical.
 */
const IDENTIFIER_START = '(?<![\\w$])';
const IDENTIFIER_END = '(?![\\w$])';

/**
 * A validated identifier, escaped for interpolation into a pattern.
 *
 * `$` is the only regex metacharacter {@link IDENTIFIER} admits, and unescaped
 * it asserts end-of-input — so an unescaped `$name` builds a pattern that
 * matches NOTHING. In a claim pattern that costs a false failure; in a write
 * pattern it is a scan that reports a clean tree.
 */
function identifierSource(name: string, noun: string): string {
  if (!IDENTIFIER.test(name)) {
    // This builds a regex, so anything else changes what the pattern matches
    // rather than failing.
    throw new Error(`'${name}' is not a plain identifier, so it cannot be built into ${noun}.`);
  }

  return name.replace(/\$/g, String.raw`\$`);
}

/** A call to the named function, as a pattern. */
function callTo(functionName: string): RegExp {
  return new RegExp(`${IDENTIFIER_START}${identifierSource(functionName, 'a claim pattern')}\\(`);
}

function refuseStatefulPattern(pattern: RegExp, noun: string): void {
  if (pattern.global || pattern.sticky) {
    // `test` advances `lastIndex` on these, so every second call reports false
    // over the same text — which here means a claim that is present reads as
    // absent, or a write that is there is never seen at all.
    throw new Error(
      `The ${noun} pattern ${String(pattern)} carries a 'g' or 'y' flag, which makes \`test\` stateful and this ` +
        `scan's answers depend on how many times it has run. Drop the flag.`,
    );
  }
}

/**
 * Whether a node is a write the scan is about.
 *
 * A CALL is matched on its callee alone, which is what keeps one write from
 * being reported twice: `seededGrants.push(await tx.pluginGrant.create({…}))`
 * is two nested calls, and matching whole texts would report the `push` as a
 * grant write as well as the `create`.
 *
 * A TAGGED TEMPLATE is matched whole, because that is where a raw
 * `INSERT INTO plugin_grants` lives — its tag is only `tx.$executeRaw`, which
 * names no table and would make every raw statement in the tree a candidate.
 */
function matchesWrite(node: ts.Node, writes: readonly WriteShape[], blanked: string, file: ts.SourceFile): boolean {
  if (ts.isCallExpression(node)) {
    const callee = blanked.slice(node.expression.getStart(file), node.expression.end);

    return writes.some((shape) => {
      if (!shape.pattern.test(callee)) {
        return false;
      }

      if (shape.withArguments === undefined) {
        return true;
      }

      const guarded = guardedText(node, shape.argumentProperty, blanked, file);

      // An unreadable payload is reported, not skipped.
      return guarded === undefined || shape.withArguments.test(guarded);
    });
  }

  if (ts.isTaggedTemplateExpression(node)) {
    // A raw statement has no callee/argument split — the statement IS both — so
    // both conditions are asked of the same text.
    const whole = blanked.slice(node.getStart(file), node.end);

    return writes.some(
      (shape) => shape.pattern.test(whole) && (shape.withArguments === undefined || shape.withArguments.test(whole)),
    );
  }

  return false;
}

/**
 * The text a {@link WriteShape.withArguments} guard is asked about, or
 * `undefined` when the payload cannot be read at all.
 *
 * `undefined` means REPORT. Falling back to the whole call was the earlier
 * behaviour and it was wrong in the silent direction: `updateMany({ where, data })`
 * — `data` a shorthand naming a literal built two lines up — has no FK column
 * anywhere in its argument text, so the guard rejected it and the write
 * vanished from the audit with no site and no exemption. The same held for
 * `update(args)` and `data: payload`. A payload this cannot enumerate is a
 * payload that might name the key.
 */
function guardedText(
  node: ts.CallExpression,
  property: string | undefined,
  blanked: string,
  file: ts.SourceFile,
): string | undefined {
  if (property === undefined) {
    return node.arguments.map((argument) => blanked.slice(argument.getStart(file), argument.end)).join(',');
  }

  const [first] = node.arguments;

  if (first === undefined || !ts.isObjectLiteralExpression(first)) {
    return undefined;
  }

  for (const member of first.properties) {
    if (ts.isPropertyAssignment(member) && ts.isIdentifier(member.name) && member.name.text === property) {
      // Only an object literal that states ALL of its own keys settles this.
      // `data: payload` names one identifier; `data: { ...payload }` names a
      // set this cannot enumerate. Either could carry the key.
      return ts.isObjectLiteralExpression(member.initializer) && enumeratesItsKeys(member.initializer)
        ? blanked.slice(member.initializer.getStart(file), member.initializer.end)
        : undefined;
    }
  }

  // Shorthand, spread, a computed name, or simply absent — in each case the
  // keys live somewhere this cannot follow.
  return undefined;
}

/** Whether every key of an object literal is visible in the literal itself. */
function enumeratesItsKeys(literal: ts.ObjectLiteralExpression): boolean {
  return literal.properties.every(
    (member) => !ts.isSpreadAssignment(member) && member.name !== undefined && !ts.isComputedPropertyName(member.name),
  );
}

/** The innermost enclosing function's body, or the file for a top-level write. */
function enclosingScope(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;

  while (current !== undefined) {
    if (ts.isFunctionLike(current)) {
      const body = (current as ts.SignatureDeclaration & { readonly body?: ts.Node }).body;

      if (body !== undefined) {
        return body;
      }
    }

    current = current.parent;
  }

  return node.getSourceFile();
}

/**
 * The nearest function NAME around a node, for the failure message.
 *
 * A variable declaration only names the node that IS its initializer, so
 * `const outcome = await this.db.$transaction(async (tx) => …)` reports the
 * method around it rather than calling the transaction body `outcome`.
 */
function enclosingName(node: ts.Node): string {
  let current: ts.Node = node;

  while (current.parent !== undefined) {
    const parent: ts.Node = current.parent;

    if (
      (ts.isMethodDeclaration(parent) || ts.isFunctionDeclaration(parent)) &&
      parent.name !== undefined &&
      ts.isIdentifier(parent.name)
    ) {
      return parent.name.text;
    }

    // A class property bound to an arrow counts as well as a `const` does —
    // `private readonly persist = async (tx) => {…}` is how a service may spell
    // a method, and without this the write inside one reports as `<top level>`,
    // a name no exemption can address and no pin can name.
    if (
      (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) &&
      ts.isIdentifier(parent.name) &&
      parent.initializer === current &&
      ts.isFunctionLike(current)
    ) {
      return parent.name.text;
    }

    current = parent;
  }

  return '<top level>';
}

/** A declaration that binds a name to a body, however it is spelled. */
function namedFunctionBody(node: ts.Node): { readonly name: string; readonly body: ts.Block } | undefined {
  if (
    (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
    node.name !== undefined &&
    ts.isIdentifier(node.name) &&
    node.body !== undefined &&
    ts.isBlock(node.body)
  ) {
    return { name: node.name.text, body: node.body };
  }

  // Both spellings of a name bound to a function: a `const`, and a class
  // property. A delegate written as a property arrow is a delegate.
  if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && ts.isIdentifier(node.name)) {
    const initializer = node.initializer;

    if (
      initializer !== undefined &&
      (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
      ts.isBlock(initializer.body)
    ) {
      return { name: node.name.text, body: initializer.body };
    }
  }

  return undefined;
}

/**
 * Whether a claim runs before `node` on every path through `scope`.
 *
 * Walks out to the scope one statement list at a time, asking of each statement
 * that PRECEDES the one being carried whether it claims unconditionally. The
 * walk is what makes nesting work: a write buried in a `for` inside an `if`
 * still sees the claim that opened the transaction, because the `if` it sits in
 * is itself preceded by that claim at the outer level.
 */
function dominatedByClaim(
  node: ts.Node,
  scope: ts.Node,
  claims: RegExp,
  blanked: string,
  file: ts.SourceFile,
): boolean {
  let current: ts.Node = node;

  while (current.parent !== undefined && current !== scope) {
    const parent: ts.Node = current.parent;
    const statements = statementListOf(parent);

    if (statements !== undefined) {
      // `indexOf` is also the membership test: a node that is not a statement
      // of this list is not positioned in it, and reports -1.
      const index = (statements as readonly ts.Node[]).indexOf(current);

      for (const preceding of index > 0 ? statements.slice(0, index) : []) {
        if (claimsOnEveryPath(preceding, claims, blanked, file)) {
          return true;
        }
      }
    }

    current = parent;
  }

  return false;
}

/**
 * Whether every path through `node` takes the claim.
 *
 * The structural cases are what make this different from a text search, and
 * each is the conservative reading:
 *
 *  - An `if` counts only with BOTH arms claiming. One arm is the installer's
 *    shape, where the claim is real on the reinstall path and absent on the
 *    fresh-install path.
 *  - A LOOP never counts. `for (const check of checks) { claim }` takes nothing
 *    when the list is empty, and an empty list is not an exotic input.
 *  - A `switch` never counts, for the reason one arm of an `if` does not, plus
 *    fallthrough.
 *
 * Anything else is judged on its text, over a copy with nested function bodies
 * blanked. That last rule is a text match, so a claim reached only through a
 * SHORT-CIRCUITING EXPRESSION counts as unconditional — a ternary
 * (`locked ? await claim() : null`), a `??`, a `&&`. No lock in this tree is
 * taken that way, and the structural cases above are where the shapes that do
 * exist live; a reader adding the first one should widen this rather than trust
 * it.
 */
function claimsOnEveryPath(node: ts.Node, claims: RegExp, blanked: string, file: ts.SourceFile): boolean {
  if (ts.isBlock(node)) {
    // In ORDER, stopping at the first statement that can leave. A block whose
    // claim sits after a guard clause does not claim on every path — the guard
    // returns having taken nothing — and `some()` over the whole list said it
    // did. That promoted a guard-clause helper to a delegate, and a delegate
    // answers for every caller's child write, which is the #398 shape wearing
    // a helper's name.
    for (const statement of node.statements) {
      if (claimsOnEveryPath(statement, claims, blanked, file)) {
        return true;
      }

      if (canLeaveEarly(statement)) {
        return false;
      }
    }

    return false;
  }

  if (ts.isIfStatement(node)) {
    return (
      node.elseStatement !== undefined &&
      claimsOnEveryPath(node.thenStatement, claims, blanked, file) &&
      claimsOnEveryPath(node.elseStatement, claims, blanked, file)
    );
  }

  if (ts.isTryStatement(node)) {
    // Same rule as an `if`, and for the same reason. Without a CATCH the
    // reasoning is "if the claim throws, the write below is not reached
    // either" — sound. With one, the throw is swallowed and execution walks on
    // to the write having taken no lock, which is the #398 shape exactly. So a
    // catch counts only when it claims too.
    return (
      claimsOnEveryPath(node.tryBlock, claims, blanked, file) &&
      (node.catchClause === undefined || claimsOnEveryPath(node.catchClause.block, claims, blanked, file))
    );
  }

  if (
    ts.isIterationStatement(node, /* lookInLabeledStatements */ false) ||
    ts.isSwitchStatement(node) ||
    ts.isLabeledStatement(node)
  ) {
    return false;
  }

  return claims.test(maskedNodeText(node, blanked, file));
}

/**
 * Whether control can leave `node` without reaching what follows it.
 *
 * Nested functions are not descended into: a `return` inside a callback returns
 * from the callback, and says nothing about the statement that defines it.
 */
function canLeaveEarly(node: ts.Node): boolean {
  let leaves = false;

  const visit = (current: ts.Node): void => {
    if (leaves || ts.isFunctionLike(current)) {
      return;
    }

    if (
      ts.isReturnStatement(current) ||
      ts.isThrowStatement(current) ||
      ts.isBreakStatement(current) ||
      ts.isContinueStatement(current)
    ) {
      leaves = true;

      return;
    }

    ts.forEachChild(current, visit);
  };

  visit(node);

  return leaves;
}

function statementListOf(node: ts.Node): ts.NodeArray<ts.Statement> | undefined {
  if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node)) {
    return node.statements;
  }

  if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
    return node.statements;
  }

  return undefined;
}

/**
 * One node's text, with the body of every function nested inside it blanked.
 *
 * Built per NODE rather than per file. The earlier form rebuilt the whole
 * source — `split('')` into a character array, mutate, `join('')` — once for
 * every function examined, which for a 59KB service with ~80 declarations is
 * several million string allocations per pass, repeated per fixpoint pass and
 * per file. Only individual statements are ever matched against, and a
 * statement is small.
 *
 * The blanking itself is what stops a claim inside a callback from answering
 * for code outside it: whether that callback runs, and in which transaction, is
 * not something a reader of source knows.
 */
function maskedNodeText(node: ts.Node, blanked: string, file: ts.SourceFile): string {
  const start = node.getStart(file);
  const characters = blanked.slice(start, node.end).split('');

  const visit = (current: ts.Node): void => {
    if (current !== node && ts.isFunctionLike(current)) {
      const body = (current as ts.SignatureDeclaration & { readonly body?: ts.Node }).body;

      if (body !== undefined) {
        for (let at = body.getStart(file) - start; at < body.end - start && at < characters.length; at += 1) {
          if (at >= 0 && characters[at] !== '\n') {
            characters[at] = ' ';
          }
        }

        return;
      }
    }

    ts.forEachChild(current, visit);
  };

  visit(node);

  return characters.join('');
}

function firstLine(text: string): string {
  const break_ = text.indexOf('\n');

  return (break_ < 0 ? text : text.slice(0, break_)).trim();
}
