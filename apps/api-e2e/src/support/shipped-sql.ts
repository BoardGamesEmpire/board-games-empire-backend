import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

const TAG = 'Prisma.sql';

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
 * Lifts the single `Prisma.sql` tagged template out of a source file's TEXT.
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
export function extractPrismaSql(source: string, sourceLabel: string, options: ExtractOptions = {}): ShippedStatement {
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

    const start = templateStarts(source).find((offset) => offset > anchorAt);

    if (start === undefined) {
      throw new Error(`No ${TAG} template after '${anchor}' in ${sourceLabel} — the statement has moved or changed.`);
    }

    return scanTemplate(source, start, sourceLabel);
  }

  const starts = templateStarts(source);

  if (starts.length === 0) {
    throw new Error(
      `No ${TAG} template found in ${sourceLabel}. The raw statement this suite executes has moved or ` +
        `changed shape — point the spec at its new home rather than pasting a copy of the SQL here.`,
    );
  }

  if (starts.length > 1) {
    // Picking one of several would produce a green test for a statement
    // nobody asked about, which is worse than no test at all.
    throw new Error(
      `Found ${starts.length} ${TAG} templates in ${sourceLabel}; this extractor can only be trusted when ` +
        `there is exactly one. Give the spec a way to name the statement it means before adding another.`,
    );
  }

  return scanTemplate(source, starts[0] as number, sourceLabel);
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
  const absolute = join(workspaceRoot(), relativePath);

  if (!existsSync(absolute)) {
    throw new Error(`Expected to find ${relativePath} at ${absolute} — the file has moved or been renamed.`);
  }

  const statement = extractPrismaSql(readFileSync(absolute, 'utf8'), relativePath, options);
  const mismatch =
    parameterMismatch(statement, expectedParams, relativePath) ??
    (options.matching ? shapeMismatch(statement, options.matching, relativePath) : undefined);

  if (mismatch) {
    throw new Error(mismatch);
  }

  return statement;
}

/** Every offset at which `needle` appears. */
function occurrences(source: string, needle: string): number[] {
  const found: number[] = [];

  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
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

/** Offsets of the backtick that opens each `Prisma.sql` template. */
function templateStarts(source: string): number[] {
  const starts: number[] = [];
  const pattern = new RegExp(`${TAG.replace('.', '\\.')}\\s*\``, 'g');

  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
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
function scanTemplate(source: string, start: number, sourceLabel: string): ShippedStatement {
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
      return { text: text.trim(), params };
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

      params.push(expression.trim());
      text += `$${params.length}`;
      continue;
    }

    text += char;
  }

  throw new Error(
    `Unterminated ${TAG} template in ${sourceLabel} — no closing backtick before end of file. ` +
      `The file is probably truncated, or the statement is built some other way now.`,
  );
}

/** Bounded upward walk to the workspace root, identified by `nx.json`. */
function workspaceRoot(): string {
  let dir = __dirname;

  for (let level = 0; level < ROOT_WALK_LIMIT; level += 1) {
    if (existsSync(join(dir, 'nx.json'))) {
      return dir;
    }

    dir = resolve(dir, '..');
  }

  throw new Error(`Could not locate the workspace root (no nx.json within ${ROOT_WALK_LIMIT} levels of ${__dirname})`);
}
