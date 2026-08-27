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
  const names = typeof relations === 'string' ? [relations] : relations;

  if (names.length === 0) {
    throw new Error(`A ${mode} stage matching no relation would match every ${mode} in the body; name the table.`);
  }

  for (const name of names) {
    if (!SAFE_RELATION.test(name)) {
      // A name carrying regex syntax would silently widen the pattern rather
      // than fail — `plugins|households` reads as one table and matches two.
      throw new Error(
        `'${name}' is not a plain relation name. This builds a regex, so anything else changes what the stage ` +
          `matches instead of failing.`,
      );
    }
  }

  const alternation = names.length > 1 ? `(?:${names.join('|')})` : names.join('|');

  return new RegExp(`FROM ${alternation}${RELATION_END}[^\`]*?${mode}`);
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
