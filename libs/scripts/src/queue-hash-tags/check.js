'use strict';
/**
 * Checks that every BullMQ queue name in `apps/` and `libs/` carries a Redis
 * hash tag, such as `{bge.mail.delivery}` (#462).
 *
 * BullMQ runs multi-key Lua scripts over a queue's keys, all of which start
 * `bull:<name>:`. A Redis-compatible server that locks the keys a script
 * touches, such as Dragonfly with `--lock_on_hashtags`, accepts the script only
 * when those keys share a hash tag. A braced name puts them in one slot, and it
 * is also what Redis Cluster needs. Nothing else notices an unbraced name: it
 * works on plain Redis and breaks only on a Redis-compatible server that cares. So every
 * registration is checked here, at the point a new queue is added.
 *
 * Names are read from the TypeScript syntax tree, one file at a time, with no
 * type checker. A name that comes from a `const`, a string enum member or a
 * `const` object member is followed to its literal. Anything that can't be
 * followed is reported as a problem rather than skipped, and finding no sites at
 * all is a problem too, so a refactor that moves registrations out of the
 * scanned patterns can't turn the check into a pass over nothing.
 *
 * It is a script run over the whole tree, not a jest spec in each lib: a spec
 * is served from the Nx cache when its own project is untouched, and a queue
 * registered in another project is not an input of that project's `test` target
 * (the same argument as for `spec-swcrc/check.js`). It needs `typescript`, so
 * CI runs it after the install.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ts = require('typescript');

/**
 * The environment without git's own variables. A git hook exports some of them
 * (`commit -a` exports GIT_INDEX_FILE), and git would then read that index or
 * repository instead of the one at the root it was given.
 */
const ENV_WITHOUT_GIT = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));

/** Tracked files plus untracked ones that aren't ignored. Merge stages are listed once per path. */
const LIST_FILES_ARGS = ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate', '--'];

/** A flow child names its queue with this property. */
const FLOW_QUEUE_PROPERTY = 'queueName';

const REGISTER_CALLS = new Set(['registerQueue', 'registerQueueAsync']);
const DECORATORS = new Set(['Processor', 'InjectQueue']);
const CONSTRUCTORS = new Set(['Queue', 'Worker', 'QueueEvents']);

/**
 * Redis Cluster's hash-tag rule: a `{` followed later by a `}` with at least one
 * character between the first `{` and the next `}`. `{}` is not a tag.
 *
 * @param {string} name
 * @returns {boolean}
 */
function hasHashTag(name) {
  const open = name.indexOf('{');
  if (open === -1) {
    return false;
  }

  const close = name.indexOf('}', open + 1);

  return close > open + 1;
}

/** Whether a path is one the check scans: source in `apps/` or `libs/`, not tests, typings or e2e apps. */
function isScanned(file) {
  if (!/^(apps|libs)\/.*\.ts$/.test(file)) {
    return false;
  }

  if (/\.(spec|e2e-spec|d)\.ts$/.test(file)) {
    return false;
  }

  return !/^apps\/[^/]*-e2e\//.test(file);
}

function git(workspaceRoot, args) {
  // stderr is piped so a git failure surfaces once, in the thrown error, rather than twice.
  return execFileSync('git', args, {
    cwd: workspaceRoot,
    env: ENV_WITHOUT_GIT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function listScannedFiles(workspaceRoot) {
  // Below the top, `ls-files` lists only that subtree, and the check would pass on part of the tree.
  if (git(workspaceRoot, ['rev-parse', '--show-prefix']).trim() !== '') {
    throw new Error(`${workspaceRoot} is not the top of its git repository, so only part of the tree would be checked`);
  }

  return (
    git(workspaceRoot, LIST_FILES_ARGS)
      .split('\0')
      .filter(Boolean)
      // The index still lists a file deleted from the working tree.
      .filter((file) => fs.existsSync(path.join(workspaceRoot, file)))
      .filter(isScanned)
  );
}

/** Strips parentheses, `as`, `satisfies`, `<T>` casts and `!` around an expression. */
function unwrap(node) {
  let current = node;

  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }

  return current;
}

function isStringLiteral(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function propertyKey(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }

  return null;
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** Every identifier a binding name introduces, including those inside a destructuring pattern. */
function bindingIdentifiers(name) {
  if (ts.isIdentifier(name)) {
    return [name];
  }

  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name)));
}

/**
 * What a name is defined as anywhere in the scanned files. A name resolves only
 * when every definition of it agrees on one string literal, so each kind of
 * definition that is not a literal is recorded as one that blocks resolution:
 *
 * - `const NAME = '...'`, a string enum member and a `const` object member, keyed
 *   `NAME` or `Owner.member`, carry their literal; a member whose value is not a
 *   literal (a template, a shorthand) carries `null`.
 * - Every other binding of a name carries `null`: a `let`/`var`, a parameter, a
 *   destructured name, a function or class, a non-literal `const`, and the local
 *   name of an aliased, default or namespace import or of an aliased export. An
 *   unaliased import is the same binding as its declaration, so it adds nothing.
 * - An owner is opaque, and `Owner.*` never resolves, once any definition of it
 *   is not an enum or an object literal, or an object literal or enum has a
 *   spread or computed key that could add members the scan can't see.
 *
 * @returns {{
 *   declarations: Map<string, Array<{ value: string | null, file: string, line: number }>>,
 *   opaque: Set<string>,
 * }}
 */
function buildDeclarations(parsed) {
  const declarations = new Map();
  const opaque = new Set();

  function record(key, value, file, sourceFile, node) {
    const entries = declarations.get(key) ?? [];
    entries.push({ value, file, line: lineOf(sourceFile, node) });
    declarations.set(key, entries);
  }

  for (const { file, sourceFile } of parsed) {
    /** A binding of `name` that is not a string literal this scan can read. */
    const block = (name, node) => {
      record(name, null, file, sourceFile, node);
      opaque.add(name);
    };

    const recordMember = (owner, key, value, node) => {
      if (key === null) {
        opaque.add(owner);
      } else {
        record(`${owner}.${key}`, value !== null && isStringLiteral(value) ? value.text : null, file, sourceFile, node);
      }
    };

    const visit = (node) => {
      if (ts.isVariableDeclaration(node)) {
        const isConst = (node.parent.flags & ts.NodeFlags.Const) !== 0;
        const initializer = node.initializer && unwrap(node.initializer);

        if (!ts.isIdentifier(node.name)) {
          for (const identifier of bindingIdentifiers(node.name)) {
            block(identifier.text, node);
          }
        } else if (isConst && initializer && ts.isObjectLiteralExpression(initializer)) {
          // The bare owner is not a string, so it must not resolve either.
          record(node.name.text, null, file, sourceFile, node);

          for (const property of initializer.properties) {
            if (ts.isPropertyAssignment(property)) {
              recordMember(node.name.text, propertyKey(property.name), unwrap(property.initializer), property);
            } else if (ts.isShorthandPropertyAssignment(property)) {
              recordMember(node.name.text, property.name.text, null, property);
            } else {
              // A spread, a method or an accessor.
              opaque.add(node.name.text);
            }
          }
        } else if (isConst && initializer && isStringLiteral(initializer)) {
          record(node.name.text, initializer.text, file, sourceFile, node);
          opaque.add(node.name.text);
        } else {
          block(node.name.text, node);
        }
      }

      if (ts.isEnumDeclaration(node)) {
        record(node.name.text, null, file, sourceFile, node);

        for (const member of node.members) {
          recordMember(
            node.name.text,
            propertyKey(member.name),
            member.initializer && unwrap(member.initializer),
            member,
          );
        }
      }

      if (ts.isParameter(node)) {
        for (const identifier of bindingIdentifiers(node.name)) {
          block(identifier.text, node);
        }
      }

      if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
        block(node.name.text, node);
      }

      if (ts.isImportSpecifier(node) && node.propertyName) {
        block(node.name.text, node);
      }

      if (ts.isImportClause(node) && node.name) {
        block(node.name.text, node);
      }

      if (ts.isNamespaceImport(node)) {
        block(node.name.text, node);
      }

      if (ts.isExportSpecifier(node) && node.propertyName) {
        block(node.name.text, node);
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return { declarations, opaque };
}

/**
 * @returns {{ name: string, definedAt?: { file: string, line: number } } | null}
 *   null when the expression is not a literal or a name that resolves to exactly one value.
 */
function resolve(expression, { declarations, opaque }) {
  const node = unwrap(expression);

  if (isStringLiteral(node)) {
    return { name: node.text };
  }

  let key = null;
  if (ts.isIdentifier(node)) {
    key = node.text;
  } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    key = opaque.has(node.expression.text) ? null : `${node.expression.text}.${node.name.text}`;
  }

  const entries = key === null ? undefined : declarations.get(key);
  if (!entries || entries.some((entry) => entry.value === null)) {
    return null;
  }

  const values = new Set(entries.map((entry) => entry.value));
  if (values.size !== 1) {
    return null;
  }

  return { name: entries[0].value, definedAt: { file: entries[0].file, line: entries[0].line } };
}

/** The expression holding the queue name in an argument that is a name or an options object. */
function nameFromArgument(argument) {
  const node = unwrap(argument);

  if (!ts.isObjectLiteralExpression(node)) {
    return node;
  }

  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property) && propertyKey(property.name) === 'name') {
      return property.initializer;
    }

    if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'name') {
      return property.name;
    }
  }

  return null;
}

function calleeName(expression) {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }

  return null;
}

/**
 * The expressions a node uses as a queue name. A `null` entry is a site whose
 * name could not be located at all, such as `@Processor()` or a spread argument.
 */
function queueNameExpressions(node) {
  if (ts.isCallExpression(node)) {
    const callee = calleeName(node.expression);

    if (callee !== null && REGISTER_CALLS.has(callee)) {
      return node.arguments.map(nameFromArgument);
    }

    if (callee !== null && ts.isIdentifier(node.expression) && DECORATORS.has(callee)) {
      return [node.arguments.length > 0 ? nameFromArgument(node.arguments[0]) : null];
    }
  }

  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && CONSTRUCTORS.has(node.expression.text)) {
    return [node.arguments && node.arguments.length > 0 ? nameFromArgument(node.arguments[0]) : null];
  }

  if (ts.isPropertyAssignment(node) && propertyKey(node.name) === FLOW_QUEUE_PROPERTY) {
    return [node.initializer];
  }

  if (ts.isShorthandPropertyAssignment(node) && node.name.text === FLOW_QUEUE_PROPERTY) {
    return [node.name];
  }

  return [];
}

/**
 * @param {Array<{ path: string, text: string }>} files
 * @returns {{
 *   sites: Array<{ file: string, line: number, name: string, definedAt?: { file: string, line: number } }>,
 *   unresolved: Array<{ file: string, line: number, expression: string }>,
 * }}
 */
function findQueueNames(files) {
  const parsed = files.map(({ path: file, text }) => ({
    file,
    sourceFile: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true),
  }));
  const declarations = buildDeclarations(parsed);

  const sites = [];
  const unresolved = [];

  for (const { file, sourceFile } of parsed) {
    const visit = (node) => {
      for (const expression of queueNameExpressions(node)) {
        const line = lineOf(sourceFile, expression ?? node);
        const resolved = expression === null ? null : resolve(expression, declarations);

        if (resolved === null) {
          unresolved.push({ file, line, expression: (expression ?? node).getText(sourceFile) });
        } else {
          sites.push({ file, line, ...resolved });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return { sites, unresolved };
}

/**
 * One problem per distinct unbraced name, listing where it is declared and every
 * place it is used, and one per site the check could not resolve.
 */
function problemsFor({ sites, unresolved }) {
  const problems = [];

  const unbraced = new Map();
  for (const site of sites) {
    if (!hasHashTag(site.name)) {
      unbraced.set(site.name, [...(unbraced.get(site.name) ?? []), site]);
    }
  }

  for (const [name, uses] of unbraced) {
    const declared = [
      ...new Set(uses.filter((use) => use.definedAt).map(({ definedAt }) => `${definedAt.file}:${definedAt.line}`)),
    ];
    const declaredIn = declared.length > 0 ? `, declared at ${declared.join(', ')}` : '';
    const usedAt = uses.map(({ file, line }) => `${file}:${line}`).join(', ');

    problems.push(
      `queue name "${name}" has no hash tag${declaredIn}; used at ${usedAt}. Brace it, as in "{bge.<area>.<name>}" (#462)`,
    );
  }

  for (const { file, line, expression } of unresolved) {
    problems.push(
      `${file}:${line}: cannot resolve the queue name \`${expression}\` to one string literal, so its hash tag can't be checked. Name the queue with a const, a string enum member or a literal (#462)`,
    );
  }

  return problems;
}

/**
 * @param {string} workspaceRoot
 * @returns {{
 *   sites: Array<{ file: string, line: number, name: string, definedAt?: { file: string, line: number } }>,
 *   problems: string[],
 * }} every queue-name site found, and one message per unbraced name or unresolvable site.
 *   Finding no sites at all is a problem too.
 */
function checkQueueHashTags(workspaceRoot) {
  const files = listScannedFiles(workspaceRoot).map((file) => ({
    path: file,
    text: fs.readFileSync(path.join(workspaceRoot, file), 'utf8'),
  }));

  const found = findQueueNames(files);
  if (found.sites.length === 0 && found.unresolved.length === 0) {
    return {
      sites: [],
      problems: ['no queue-name sites found, so nothing was checked; the scan patterns may no longer match (#462)'],
    };
  }

  return { sites: found.sites, problems: problemsFor(found) };
}

module.exports = { checkQueueHashTags, findQueueNames, hasHashTag };
