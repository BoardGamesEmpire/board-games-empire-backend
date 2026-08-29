import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/**
 * A raw statement lifted out of application source, in a form `pg` can
 * execute: `${…}` interpolations replaced by positional parameters, and the
 * expressions that stood in them kept for the caller to pin.
 */
export interface ShippedStatement {
  /** The statement text, with `$1`, `$2`, … where the template interpolated. */
  readonly text: string;

  /** The interpolated expressions, verbatim and in the order they appeared. */
  readonly params: readonly string[];
}

/**
 * The opening backtick of a tagged raw-SQL template.
 *
 * Three tags, because the repo ships two idioms: the household services wrap
 * their statements in `Prisma.sql`, and the plugin runtime tags them straight
 * on the client (`tx.$queryRaw`, `tx.$executeRaw`). Both are correct Prisma;
 * neither is going away before #387 settles which one the repo keeps, and until
 * then a lifter that knew only one would leave every plugin lock provable only
 * against a copy (D-360-1).
 *
 * The optional `<…>` steps over a generic row type — `tx.$queryRaw<Row[]>` puts
 * one exactly where the backtick would otherwise be. It is lazy, so a type that
 * closes with `>>` still resolves: the match must end at a backtick, and the
 * engine backtracks to the outer `>` to get there.
 *
 * That group excludes backticks, and the exclusion is load-bearing rather than
 * tidy. Allowed to match anything, it backtracks straight out of
 * `$queryRaw<A[]>(Prisma.sql\`…\`)` and on to the NEXT statement's `>`,
 * swallowing both into a single match — so a file holding two statements looks
 * like a file holding one, the "refuses to guess" gate never fires, and the
 * lift silently returns the second statement. A type argument cannot contain a
 * backtick, so nothing legitimate is lost.
 *
 * A wrapped statement (`tx.$queryRaw(Prisma.sql\`…\`)`) carries both tags but
 * matches ONCE: the backtick must follow the tag, and `$queryRaw` here is
 * followed by `(`. Counting the pair twice would make every existing
 * single-statement file look ambiguous and refuse to lift anything.
 */
const SQL_TEMPLATE = /(?:Prisma\.sql|\$queryRaw|\$executeRaw)\s*(?:<[^`]*?>\s*)?`/;

/**
 * The opening backtick of an UNTAGGED template — one assigned to a name, or
 * passed straight into a call.
 *
 * Advisory locks are keyed on a string the application builds in TypeScript,
 * one line above the statement that hashes it, so lifting only the statement
 * leaves a spec free to invent its own key format. A barrier whose two sides
 * agree on a format production no longer uses blocks beautifully and proves
 * nothing (D-360-1).
 *
 * A tagged template can never match this: its backtick is preceded by an
 * identifier, never by `=`, `(` or `,`.
 */
const VALUE_TEMPLATE = /[=(,]\s*`/;

/**
 * One liftable template shape: how to find it, what to call it in a failure,
 * and whether its surrounding whitespace is formatting or content.
 */
interface TemplateForm {
  readonly pattern: RegExp;
  readonly noun: string;

  /**
   * SQL is laid out across lines, so its indentation is formatting and `pg`
   * should not receive it. A key format is the string itself — trimming it
   * would leave both sides of a barrier agreeing on a key production never
   * takes, blocking exactly as expected and proving nothing.
   */
  readonly trim: boolean;
}

const SQL_FORM: TemplateForm = { pattern: SQL_TEMPLATE, noun: 'raw SQL', trim: true };
const VALUE_FORM: TemplateForm = { pattern: VALUE_TEMPLATE, noun: 'value', trim: false };

export interface ExtractOptions {
  /**
   * Text the wanted template follows — in practice the name of the function
   * that issues it. Required once a file holds more than one statement, and
   * worth passing before that: it turns "the file grew a second lock" from a
   * silently wrong test into a named failure.
   */
  readonly after?: string;

  /**
   * A clause the lifted statement must carry — in practice its locking mode.
   * Worth passing wherever a file holds more than one statement: it is what
   * catches an anchor that resolved to the wrong one, which the parameter check
   * cannot see when both bind the same values.
   */
  readonly matching?: RegExp;
}

/** How far above this file the workspace root may be, before we give up. */
const ROOT_WALK_LIMIT = 8;

/**
 * Lifts the single raw SQL template out of a source file's TEXT.
 *
 * The concurrency suite (#239) has to execute the statement the application
 * ships, not a copy of it. A copy passes forever: it keeps proving that some
 * SQL serializes long after the service's own SQL stopped looking like it, and
 * the mechanics proof this issue exists for becomes silently vacuous. Prisma
 * exposes no way to ask a service for its SQL without running it, and the suite
 * is black-box — the test process never imports application code — so the
 * source text is both the authoritative form and the only available one.
 *
 * Every failure below is loud on purpose. A statement that cannot be found or
 * cannot be parsed must fail the suite with the file named, because the
 * alternative — falling back to a hardcoded copy — reintroduces exactly the
 * drift this function exists to prevent.
 */
export function extractSqlTemplate(
  source: string,
  sourceLabel: string,
  options: ExtractOptions = {},
): ShippedStatement {
  return extract(source, sourceLabel, options, SQL_FORM);
}

/**
 * Lifts the single untagged template out of a source file's TEXT — the string
 * an advisory lock is keyed on, rather than a statement.
 *
 * Same contract as {@link extractSqlTemplate}, and the same reason: a spec that
 * rebuilds `plugin_grant:household_unit:${id}:${pluginId}` by hand is asserting
 * its own format. Lift the format, bind values into it with
 * {@link bindTemplate}, and a change to it either fails the lift or produces
 * the new key.
 */
export function extractValueTemplate(
  source: string,
  sourceLabel: string,
  options: ExtractOptions = {},
): ShippedStatement {
  return extract(source, sourceLabel, options, VALUE_FORM);
}

/**
 * Substitutes values into a lifted template, reproducing the string the
 * application would have built.
 *
 * Arity is enforced rather than tolerated. An unsubstituted `$2` is still a
 * perfectly valid advisory key, so both sides of a barrier would agree on it
 * and block exactly as the spec expects — while saying nothing about the key
 * production takes.
 */
export function bindTemplate(statement: ShippedStatement, values: readonly string[]): string {
  if (values.length !== statement.params.length) {
    throw new Error(
      `This template interpolates ${statement.params.length} value(s) — [${statement.params.join(', ')}] — but ` +
        `${values.length} were supplied. Bind one per interpolation, in order.`,
    );
  }

  return statement.text.replace(/\$(\d+)/g, (_match, index: string) => {
    const value = values[Number(index) - 1];

    if (value === undefined) {
      // Not unreachable: a literal `$5` written in the template body is
      // indistinguishable from a placeholder once the text is built. Refusing
      // by name beats substituting something arbitrary into a key.
      throw new Error(
        `This template's text carries $${index}, but it interpolates only ${statement.params.length} value(s). ` +
          `A literal '$' followed by digits cannot be told apart from a placeholder — bind it outside the ` +
          `template, or escape it.`,
      );
    }

    return value;
  });
}

/**
 * Compares the expressions a shipped statement interpolates against what the
 * spec binds for, returning a failure message or `undefined`.
 *
 * Positional parameters make a reordering invisible: the statement still
 * executes, the values still bind, and the test still passes while asserting
 * something else entirely. So the spec states what it expects to be binding,
 * and a change to the shipped statement's parameters has to be acknowledged.
 */
export function parameterMismatch(
  statement: ShippedStatement,
  expected: readonly string[],
  sourceLabel: string,
): string | undefined {
  const actual = statement.params;
  const same = actual.length === expected.length && actual.every((param, index) => param === expected[index]);

  if (same) {
    return undefined;
  }

  return (
    `${sourceLabel} now interpolates [${actual.join(', ')}] where this spec binds [${expected.join(', ')}]. ` +
    `The values a spec supplies are positional, so a reordering or a new parameter binds the wrong data ` +
    `without failing — update the spec's bindings deliberately.`
  );
}

/**
 * Checks that a lifted statement carries the clause the caller is about to test,
 * returning a failure message or `undefined`.
 *
 * The backstop for an anchor that resolved to the wrong statement in a file
 * holding several. {@link parameterMismatch} cannot catch that on its own: the
 * two household locks both bind a single `householdId`, so the locking clause is
 * the only thing that says which one was lifted.
 */
export function shapeMismatch(statement: ShippedStatement, pattern: RegExp, sourceLabel: string): string | undefined {
  if (pattern.test(statement.text)) {
    return undefined;
  }

  return (
    `The statement lifted from ${sourceLabel} does not match ${String(pattern)}, so it is not the one this ` +
    `spec means. Either the anchor resolved to a neighbouring statement, or the statement changed. Lifted: ` +
    `${statement.text.replace(/\s+/g, ' ').slice(0, 200)}`
  );
}

/**
 * Reads a workspace-relative source file and lifts its statement, asserting the
 * parameters are the ones the caller binds for.
 *
 * The path is workspace-relative and stated by the caller rather than
 * discovered: naming the wrong file is worse than naming none, and a moved
 * statement should fail with the path it looked for (#248's rule, applied to
 * source instead of `.prisma` models).
 */
export function readShippedSql(
  relativePath: string,
  expectedParams: readonly string[],
  options: ExtractOptions = {},
): ShippedStatement {
  return readShipped(relativePath, expectedParams, options, extractSqlTemplate);
}

/**
 * The {@link extractValueTemplate} half of {@link readShippedSql} — for the
 * advisory keys, which are strings rather than statements.
 */
export function readShippedValue(
  relativePath: string,
  expectedParams: readonly string[],
  options: ExtractOptions = {},
): ShippedStatement {
  return readShipped(relativePath, expectedParams, options, extractValueTemplate);
}

/**
 * A workspace-relative source file's text, for the rare pin that is neither a
 * statement nor a template.
 *
 * `QuotaService.advisoryLockKey` is the case: its digest recipe (sha1, first
 * eight bytes, big-endian) is ordinary TypeScript, and a spec that recomputes
 * the key has to know that recipe has not changed underneath it. Failing here
 * names the file, the same as every other lift.
 */
export function readShippedSource(relativePath: string): string {
  const absolute = join(workspaceRoot(), relativePath);

  if (!existsSync(absolute)) {
    throw new Error(`Expected to find ${relativePath} at ${absolute} — the file has moved or been renamed.`);
  }

  return readFileSync(absolute, 'utf8');
}

function readShipped(
  relativePath: string,
  expectedParams: readonly string[],
  options: ExtractOptions,
  lift: (source: string, sourceLabel: string, options: ExtractOptions) => ShippedStatement,
): ShippedStatement {
  const statement = lift(readShippedSource(relativePath), relativePath, options);
  const mismatch =
    parameterMismatch(statement, expectedParams, relativePath) ??
    (options.matching ? shapeMismatch(statement, options.matching, relativePath) : undefined);

  if (mismatch) {
    throw new Error(mismatch);
  }

  return statement;
}

/** The shared body of both extractors; the form names the shape in every failure. */
function extract(source: string, sourceLabel: string, options: ExtractOptions, form: TemplateForm): ShippedStatement {
  const { pattern, noun } = form;
  const anchor = options.after;

  if (anchor !== undefined) {
    const mentions = occurrences(source, anchor);
    const anchorAt = mentions.find((offset) => !isOnACommentLine(source, offset));

    if (anchorAt === undefined) {
      if (mentions.length > 0) {
        // The quiet one. A `{@link thisFunction}` added to a NEIGHBOURING
        // docstring sits above the real declaration, so a naive search anchors
        // there and lifts the neighbour's statement instead — and when both
        // statements bind the same parameters, nothing downstream notices.
        throw new Error(
          `'${anchor}' appears in ${sourceLabel} only inside comments, never as a declaration. A spec must ` +
            `anchor on the code that issues the statement, not on prose that mentions it.`,
        );
      }

      throw new Error(
        `No '${anchor}' in ${sourceLabel}, so the statement this spec means cannot be located. It was ` +
          `renamed or moved — point the spec at the new name rather than letting it read whichever ` +
          `statement happens to be first.`,
      );
    }

    const starts = templateStarts(source, pattern);
    const start = starts.find((offset) => offset > anchorAt);

    if (start === undefined) {
      throw new Error(`No ${noun} template after '${anchor}' in ${sourceLabel} — the statement has moved or changed.`);
    }

    // A name is mentioned at its declaration AND at every call site, and an
    // anchor takes the first non-comment mention — which in
    // `household-member.service.ts` is a call 600 lines above the declaration.
    // That is harmless only while every mention leads to the same statement.
    // The moment they diverge, the earliest call site retargets the lift onto a
    // neighbour's statement, and when both bind the same parameters nothing
    // downstream notices. Same instinct as refusing to pick one of two
    // templates: say so rather than choose.
    const resolved = new Set(
      mentions
        .filter((offset) => !isOnACommentLine(source, offset))
        .map((offset) => starts.find((candidate) => candidate > offset))
        .filter((candidate): candidate is number => candidate !== undefined),
    );

    if (resolved.size > 1) {
      throw new Error(
        `'${anchor}' appears in ${sourceLabel} more than once — at its declaration and at a call site — and ` +
          `the mentions lead to different ${noun} templates. Anchor on something that appears only at the ` +
          `declaration (the name with its modifiers, say) so the statement this spec means is not decided by ` +
          `which mention happens to come first.`,
      );
    }

    return scanTemplate(source, start, sourceLabel, form);
  }

  const starts = templateStarts(source, pattern);

  if (starts.length === 0) {
    throw new Error(
      `No ${noun} template found in ${sourceLabel}. The raw statement this suite executes has moved or ` +
        `changed shape — point the spec at its new home rather than pasting a copy of the SQL here.`,
    );
  }

  if (starts.length > 1) {
    // Picking one of several would produce a green test for a statement
    // nobody asked about, which is worse than no test at all.
    throw new Error(
      `Found ${starts.length} ${noun} templates in ${sourceLabel}; this extractor can only be trusted when ` +
        `there is exactly one. Give the spec a way to name the statement it means before adding another.`,
    );
  }

  return scanTemplate(source, starts[0] as number, sourceLabel, form);
}

/** A single decimal digit — see the placeholder-ambiguity refusal in {@link scanTemplate}. */
const DIGIT = /[0-9]/;

/** Identifier characters, for deciding where one name ends and another begins. */
const IDENTIFIER_CHARACTER = /[A-Za-z0-9_$]/;

/**
 * Every offset at which `needle` appears AS A WHOLE NAME.
 *
 * The boundary check is load-bearing rather than tidy. `lockHouseholdUnit` is a
 * prefix of `lockHouseholdUnitScope`, and the plugin runtime ships both — with
 * the longer one imported at the top of the file, far above either statement.
 * A substring anchor resolves to that import and lifts whichever template
 * follows it, which is silently wrong precisely when the two statements bind
 * the same parameters and nothing downstream notices.
 */
function occurrences(source: string, needle: string): number[] {
  const found: number[] = [];

  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
    const before = source[at - 1];
    const after = source[at + needle.length];

    if (before !== undefined && IDENTIFIER_CHARACTER.test(before)) {
      continue;
    }

    if (after !== undefined && IDENTIFIER_CHARACTER.test(after)) {
      continue;
    }

    found.push(at);
  }

  return found;
}

/**
 * Whether an offset sits on a line that is comment prose — a `*` continuation
 * of a block comment, a `//` line comment, or the opening of either.
 *
 * Deliberately line-shaped rather than a comment parser: every mention this
 * needs to reject is a docstring reference, and the alternative is tracking
 * comment state through strings and templates for no additional accuracy here.
 */
function isOnACommentLine(source: string, offset: number): boolean {
  const lineStart = source.lastIndexOf('\n', offset) + 1;
  const before = source.slice(lineStart, offset).trimStart();

  return before.startsWith('*') || before.startsWith('//') || before.startsWith('/*');
}

/**
 * Offsets just past the backtick that opens each template of the wanted shape,
 * skipping any that lives inside a comment.
 *
 * Doc comments in this repo quote code, and a quoted key format is
 * indistinguishable from a real one to a pattern that only inspects the
 * character before the backtick — `unit-scope-lock.ts` already carries such a
 * mention. Counted, it inflates the ambiguity check; anchored past, it is
 * lifted in preference to the statement the spec meant.
 */
function templateStarts(source: string, pattern: RegExp): number[] {
  const starts: number[] = [];
  const scanner = new RegExp(pattern.source, 'g');

  for (let match = scanner.exec(source); match !== null; match = scanner.exec(source)) {
    if (isOnACommentLine(source, match.index)) {
      continue;
    }

    starts.push(match.index + match[0].length);
  }

  return starts;
}

/**
 * Walks the template from its opening backtick, swapping `${…}` for `$n`.
 *
 * Brace depth is tracked rather than stopping at the first `}` so an
 * expression such as `${pick({ a: 1 })}` survives; a backtick inside an
 * interpolation (a nested template) is refused rather than mis-parsed.
 */
function scanTemplate(source: string, start: number, sourceLabel: string, form: TemplateForm): ShippedStatement {
  const { noun } = form;
  const params: string[] = [];
  let text = '';

  for (let index = start; index < source.length; index += 1) {
    const char = source[index] as string;

    if (char === '\\') {
      text += char + (source[index + 1] ?? '');
      index += 1;
      continue;
    }

    if (char === '`') {
      return { text: form.trim ? text.trim() : text, params };
    }

    if (char === '$' && source[index + 1] === '{') {
      let depth = 1;
      let expression = '';

      for (index += 2; index < source.length && depth > 0; index += 1) {
        const inner = source[index] as string;

        if (inner === '`') {
          throw new Error(
            `A nested template literal inside an interpolation in ${sourceLabel} is beyond what this ` +
              `extractor can read. Simplify the statement, or bind the value outside the template.`,
          );
        }

        if (inner === '{') {
          depth += 1;
        } else if (inner === '}') {
          depth -= 1;
          if (depth === 0) {
            break;
          }
        }

        expression += inner;
      }

      if (depth > 0) {
        throw new Error(`Unterminated interpolation in ${sourceLabel} — no closing brace before end of file.`);
      }

      // `${prefix}2` would render as `$12` — placeholder twelve to everything
      // downstream. Under twelve interpolations that is a confusing throw at
      // bind time; at twelve or more it silently binds the wrong value, which
      // in a key format is the exact drift this module exists to prevent. The
      // scheme cannot express it, so refuse rather than emit it.
      const next = source[index + 1];

      if (next !== undefined && DIGIT.test(next)) {
        throw new Error(
          `An interpolation in ${sourceLabel} is immediately followed by the digit '${next}', which makes its ` +
            `positional placeholder ambiguous ($${params.length + 1} followed by ${next} reads as ` +
            `$${params.length + 1}${next}). Separate them, or bind the value outside the template.`,
        );
      }

      params.push(expression.trim());
      text += `$${params.length}`;
      continue;
    }

    text += char;
  }

  throw new Error(
    `Unterminated ${noun} template in ${sourceLabel} — no closing backtick before end of file. ` +
      `The file is probably truncated, or the statement is built some other way now.`,
  );
}

/** One shipped source file, labelled the way every lift in this suite labels one. */
export interface ShippedFile {
  /** Workspace-relative, so a failure names the path a reader can open. */
  readonly path: string;
  readonly source: string;
}

/**
 * Every shipped `.ts` file under a workspace-relative directory, specs excluded.
 *
 * The lifts above all name ONE file, which is right when a spec is pinning a
 * path it can name. The FK-implied-lock check (#399) cannot: its whole point is
 * to reach a writer nobody added to a list, so it has to enumerate the tree
 * instead of being handed it.
 *
 * Refuses an empty result. A scan of the wrong directory returns no files and
 * therefore no violations, which is indistinguishable from a clean tree.
 */
export function readShippedTree(relativeDir: string): readonly ShippedFile[] {
  const absolute = join(workspaceRoot(), relativeDir);

  if (!existsSync(absolute)) {
    throw new Error(`Expected to find ${relativeDir} at ${absolute} — the directory has moved or been renamed.`);
  }

  const files = readdirSync(absolute, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.d.ts'))
    .sort()
    .map((entry) => ({
      // POSIX separators, because the path doubles as the label a spec asserts
      // on and a Windows checkout must not rewrite what the pin says.
      path: `${relativeDir}/${entry.split(sep).join('/')}`,
      source: readFileSync(join(absolute, entry), 'utf8'),
    }));

  if (files.length === 0) {
    throw new Error(
      `No shipped .ts files under ${relativeDir}. A scan of an empty tree reports no findings, which reads ` +
        `exactly like a scan that found nothing wrong.`,
    );
  }

  return files;
}

/**
 * The repo root, found by walking up for `nx.json`.
 *
 * Exported because two other support modules resolve workspace-relative paths
 * the same way — the Prisma schema reader and the source scanner behind the
 * FK-implied-lock check (#399). A second copy of the walk is a second thing to
 * correct when the layout moves, and the copy nobody looks at is the one that
 * silently resolves to the wrong directory.
 */
export function workspaceRoot(): string {
  let dir = __dirname;

  for (let level = 0; level < ROOT_WALK_LIMIT; level += 1) {
    if (existsSync(join(dir, 'nx.json'))) {
      return dir;
    }

    dir = resolve(dir, '..');
  }

  throw new Error(`Could not locate the workspace root (no nx.json within ${ROOT_WALK_LIMIT} levels of ${__dirname})`);
}
