import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * A revoked grant (#772) stays in `role_permissions` so bootstrap does not give
 * it back, and confers nothing. That holds only while every reader of a role's
 * grants skips it, so this scan fails the build when a new reader forgets.
 *
 * It reads source rather than running a query: a loader that forgets the
 * filter returns the same rows as one that has it until somebody revokes a
 * grant, so a behavioural test would pass for exactly the reader that is
 * wrong. The reconciler's `catalog/` is skipped because it must see revoked
 * rows.
 *
 * It parses each file with TypeScript, so how a query is laid out across lines
 * makes no difference. A read of a role's grants is a `permissions` key in the
 * `select` or `include` (or the `_count` select) of a query on Role: the value
 * of a `role` key, which is what every relation to Role is named (pinned
 * below), or the argument of a call on the Role delegate (`tx.role.findMany`).
 * Its `where` must hold `revokedAt: null` itself. One the scan can't read, such
 * as a filter or a whole `permissions` value held in a variable, counts as
 * unfiltered, so it fails loudly rather than passing.
 *
 * Out of its reach:
 *
 * - a role's `select` or `include` built as an object in one place and passed
 *   by name to the query in another, since nothing in the object says it is
 *   for Role. Write a role's grant read inline in the query, or in a function
 *   that returns it under its `role` key, as `voterGrantSelect` does, where
 *   the scan sees it.
 * - a relation filter on a role's grants (`where: { permissions: { some: … } }`),
 *   which selects roles rather than reading grants. None exists today; one
 *   that asks which roles hold a permission needs `revokedAt: null` inside it.
 *
 * The readers live in projects that depend on this one, so the `test` target
 * hashes, through a runtime input, every `.ts` source under `libs/` and
 * `apps/` that mentions a permission: without that, a new reader elsewhere
 * leaves this target's hash alone, and CI restores the cached pass instead of
 * scanning it (docs/NX_CACHING.md). Every read below names a permission, so a
 * file the input leaves out has nothing to flag. A new pattern must name one
 * too, or the input must widen with it.
 */
const REPO_ROOT = join(__dirname, '../../../../..');
const SCANNED_ROOTS = ['libs', 'apps'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'out-tsc', 'generated', 'coverage']);
/**
 * The reconciler's directory: the one reader that must see revoked grants.
 * Skipped by path, so a `catalog` directory anywhere else is still scanned.
 */
const RECONCILER_DIR = join(REPO_ROOT, 'libs/database/src/lib/catalog');
const SCHEMA_DIR = join(REPO_ROOT, 'prisma');

/** The keys under which a query reads a relation's rows. */
const READ_KEYS = new Set(['select', 'include']);
/** What every relation to Role is named, and the Role delegate's name. */
const ROLE_KEY = 'role';
/**
 * A direct read of `RolePermission` rows: a call on its delegate, the
 * `rolePermissions` relation read as `true` or as an object, or SQL naming
 * its table. Each names a permission, as the runtime input needs.
 */
const DIRECT_READ =
  /\brolePermission\.(find\w*|count|groupBy|aggregate)\b|\brolePermissions:\s*(\{|true\b)|\b(FROM|JOIN)\s+"?role_permissions\b/i;

function skipsDir(path: string): boolean {
  return SKIPPED_DIRS.has(basename(path)) || path === RECONCILER_DIR;
}

function sourceFiles(dir: string, extension = '.ts'): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return skipsDir(path) ? [] : sourceFiles(path, extension);
    }
    return entry.name.endsWith(extension) && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')
      ? [path]
      : [];
  });
}

interface Read {
  file: string;
  line: number;
  text: string;
}

interface Scan {
  reads: Read[];
  unfiltered: Read[];
}

/** An expression that wraps another without changing its value: `(…)`, `as const`, `satisfies T`, `<T>…`, `…!`. */
type Wrapper =
  ts.ParenthesizedExpression | ts.AsExpression | ts.SatisfiesExpression | ts.TypeAssertion | ts.NonNullExpression;

function isWrapper(node: ts.Node): node is Wrapper {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  );
}

/** `expression` with its wrappers taken off. */
function unwrap(expression: ts.Expression): ts.Expression {
  return isWrapper(expression) ? unwrap(expression.expression) : expression;
}

/** `node` with every wrapper around it, so its `parent` is what holds the value. */
function withWrappers(node: ts.Node): ts.Node {
  return isWrapper(node.parent) ? withWrappers(node.parent) : node;
}

/** A property key as written, when it is a plain name or a string. */
function keyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)
    ? name.text
    : undefined;
}

/** The property `object` is the value of, if any: `select: { … }` for the braces. */
function propertyHolding(object: ts.ObjectLiteralExpression): ts.PropertyAssignment | undefined {
  const outer = withWrappers(object);
  return ts.isPropertyAssignment(outer.parent) && outer.parent.initializer === outer ? outer.parent : undefined;
}

/** The query arguments a `select`/`include` object belongs to, when it is the value of one of those keys. */
function argumentsOfSelection(selection: ts.ObjectLiteralExpression): ts.ObjectLiteralExpression | undefined {
  const holder = propertyHolding(selection);
  const key = holder && keyName(holder.name);
  return key !== undefined && READ_KEYS.has(key) ? holder?.parent : undefined;
}

/**
 * Whether `args` are a query's arguments on Role: the value of a `role` key,
 * or an argument of a call on the Role delegate (`tx.role.findMany(args)`).
 */
function isRoleQuery(args: ts.ObjectLiteralExpression): boolean {
  const holder = propertyHolding(args);
  if (holder !== undefined) {
    return keyName(holder.name) === ROLE_KEY;
  }

  const outer = withWrappers(args);
  const call = outer.parent;
  if (!ts.isCallExpression(call) || !call.arguments.some((argument) => argument === outer)) {
    return false;
  }
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) {
    return false;
  }
  const delegate = unwrap(callee.expression);
  return (
    (ts.isIdentifier(delegate) && delegate.text === ROLE_KEY) ||
    (ts.isPropertyAccessExpression(delegate) && delegate.name.text === ROLE_KEY)
  );
}

/** Whether `property`, a `permissions` key, reads a role's grants. */
function readsRoleGrants(property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment): boolean {
  const args = argumentsOfSelection(property.parent);
  if (args === undefined) {
    return false;
  }

  // `_count: { select: { permissions } }` counts a role's grants: the role's
  // query is one selection further out.
  const count = propertyHolding(args);
  if (count !== undefined && keyName(count.name) === '_count') {
    const outer = argumentsOfSelection(count.parent);
    return outer !== undefined && isRoleQuery(outer);
  }

  return isRoleQuery(args);
}

/** Whether a `permissions` value's own `where` holds `revokedAt: null`. */
function filtersRevoked(value: ts.Expression): boolean {
  const object = unwrap(value);
  if (!ts.isObjectLiteralExpression(object)) {
    return false;
  }

  const where = object.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && keyName(property.name) === 'where',
  );
  const filter = where && unwrap(where.initializer);

  return (
    filter !== undefined &&
    ts.isObjectLiteralExpression(filter) &&
    filter.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        keyName(property.name) === 'revokedAt' &&
        unwrap(property.initializer).kind === ts.SyntaxKind.NullKeyword,
    )
  );
}

/**
 * Every read of a role's `permissions` relation in one file's source, and each
 * one that keeps revoked grants. `permissions: false` reads nothing. A type
 * literal such as `permissions: { id: string }[]` is a type, not a query, so
 * it is never a read.
 */
function scanSource(file: string, source: string): Scan {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = source.split('\n');
  const reads: Read[] = [];
  const unfiltered: Read[] = [];

  const visit = (node: ts.Node): void => {
    const isPermissions =
      (ts.isPropertyAssignment(node) &&
        keyName(node.name) === 'permissions' &&
        unwrap(node.initializer).kind !== ts.SyntaxKind.FalseKeyword) ||
      (ts.isShorthandPropertyAssignment(node) && node.name.text === 'permissions');

    if (isPermissions && readsRoleGrants(node)) {
      const index = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
      const read = { file, line: index + 1, text: lines[index].trim() };
      reads.push(read);
      if (!ts.isPropertyAssignment(node) || !filtersRevoked(node.initializer)) {
        unfiltered.push(read);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { reads, unfiltered };
}

function scan(files: string[]): Scan {
  const scans = files.map((file) => scanSource(relative(REPO_ROOT, file), readFileSync(file, 'utf-8')));

  return { reads: scans.flatMap(({ reads }) => reads), unfiltered: scans.flatMap(({ unfiltered }) => unfiltered) };
}

/** The name of the field a Prisma schema line declares, when its type is Role; never the `model Role` line itself. */
function roleRelationName(text: string): string | undefined {
  const field = /^\s*(\w+)\s+Role(\[\]|\?)?(\s|$)/.exec(text);
  return field !== null && !['model', 'enum', 'type', 'view'].includes(field[1]) ? field[1] : undefined;
}

/** Every field in the Prisma schema whose type is Role, by name. */
function roleRelationNames(schemaFiles: string[]): string[] {
  return schemaFiles.flatMap((file) =>
    readFileSync(file, 'utf-8')
      .split('\n')
      .flatMap((text) => roleRelationName(text) ?? []),
  );
}

describe('revoked grant loaders (#772)', () => {
  const files = SCANNED_ROOTS.flatMap((root) => sourceFiles(join(REPO_ROOT, root)));
  const { reads, unfiltered } = scan(files);

  it('every role grant select filters revoked grants (#772)', () => {
    const checked = [...new Set(reads.map((read) => read.file))];

    // Not vacuous: the ability loader and the vote count both read role grants.
    expect(checked.length).toBeGreaterThanOrEqual(2);
    expect(checked).toEqual(
      expect.arrayContaining([
        expect.stringContaining('permissions.service.ts'),
        expect.stringContaining('vote-grant.ts'),
      ]),
    );
    expect(unfiltered.map((read) => `${read.file}:${read.line} ${read.text}`)).toEqual([]);
  });

  it('every relation to Role is named role, which is how the scan knows a role query (#772)', () => {
    // A relation to Role under another name would be a reader the scan never
    // looks at. Rename it `role`, or teach the scan the new name.
    const names = roleRelationNames(sourceFiles(SCHEMA_DIR, '.prisma'));

    expect(names.length).toBeGreaterThanOrEqual(4);
    expect(names.filter((name) => name !== ROLE_KEY)).toEqual([]);
  });

  it('nothing outside the catalog reads RolePermission rows directly (#772)', () => {
    // A direct read would need its own filter; none exists, and this keeps it so
    // until one is added deliberately, with the filter and a scan that covers it.
    const direct = files.flatMap((file) =>
      readFileSync(file, 'utf-8')
        .split('\n')
        .flatMap((text, index) =>
          DIRECT_READ.test(text) ? [`${relative(REPO_ROOT, file)}:${index + 1} ${text.trim()}`] : [],
        ),
    );

    expect(direct).toEqual([]);
  });
});

describe('the revoked grant scan itself (#772)', () => {
  it('counts the rolePermissions relation as a direct read whether it is read as true or as an object', () => {
    // `include: { rolePermissions: true }` returns revoked grants as surely as
    // a select does, and is the shorter way to write the read.
    expect(DIRECT_READ.test('include: { rolePermissions: true },')).toBe(true);
    expect(DIRECT_READ.test('select: { rolePermissions: { select: { roleId: true } } },')).toBe(true);
    expect(DIRECT_READ.test('_count: { select: { rolePermissions: true } },')).toBe(true);
    expect(DIRECT_READ.test('rolePermissions: truly,')).toBe(false);
  });

  /** The lines `scanSource` reports unfiltered in `source`, 1-based. */
  const unfilteredLines = (source: readonly string[]) =>
    scanSource('fixture.ts', source.join('\n')).unfiltered.map(({ line }) => line);
  /** The lines `scanSource` counts as reads of a role's grants in `source`, 1-based. */
  const readLines = (source: readonly string[]) =>
    scanSource('fixture.ts', source.join('\n')).reads.map(({ line }) => line);

  it('catches a read whose permissions select sits on one line', () => {
    expect(
      unfilteredLines([
        'const q = {',
        '  role: {',
        '    select: { permissions: { select: { id: true } } },',
        '  },',
        '};',
      ]),
    ).toEqual([3]);
    expect(
      unfilteredLines([
        'const q = {',
        '  role: {',
        '    select: { permissions: { where: { revokedAt: null }, select: { id: true } } },',
        '  },',
        '};',
      ]),
    ).toEqual([]);
  });

  it('catches a read through the Role model, which has no role key to find', () => {
    expect(
      unfilteredLines([
        'const roles = await tx.role.findMany({',
        '  select: {',
        '    name: true,',
        '    permissions: {',
        '      select: { permission: true },',
        '    },',
        '  },',
        '});',
      ]),
    ).toEqual([4]);
    expect(
      unfilteredLines([
        'const roles = await tx.role.findMany({ include: { permissions: { include: { permission: true } } } });',
      ]),
    ).toEqual([1]);
  });

  it('finds the role however far its select runs before permissions', () => {
    // Prettier puts each selected field on its own line, so a role select with
    // many fields before `permissions` sits far below its `role` key.
    const fields = Array.from({ length: 12 }, (_, index) => `        field${index}: true,`);
    expect(
      unfilteredLines([
        'const q = {',
        '  member: {',
        '    select: {',
        '      role: {',
        '        select: {',
        ...fields,
        '          permissions: { select: { id: true } },',
        '        },',
        '      },',
        '    },',
        '  },',
        '};',
      ]),
    ).toEqual([18]);
  });

  it('finds the filter however far its where sits from permissions', () => {
    expect(
      unfilteredLines([
        'await this.prisma.role.findUnique({',
        '  where: { id },',
        '  select: {',
        '    permissions: {',
        '      orderBy: { id: "asc" },',
        '      take: 10,',
        '      skip: 0,',
        '      select: { id: true },',
        '      where: {',
        '        permission: { retiredAt: null },',
        '        revokedAt: null,',
        '      },',
        '    },',
        '  },',
        '});',
      ]),
    ).toEqual([]);
  });

  it('holds a filter it cannot read against the read', () => {
    // `revokedAt: { not: null }` reads only revoked grants, a filter held in a
    // variable can't be checked, and neither can a whole value in one.
    expect(
      unfilteredLines([
        'tx.role.findMany({ select: { permissions: { where: { revokedAt: { not: null } } } } });',
        'tx.role.findMany({ select: { permissions: { where: liveGrants } } });',
        'tx.role.findMany({ select: { permissions } });',
        'tx.role.findMany({ select: { permissions: grantSelect } });',
      ]),
    ).toEqual([1, 2, 3, 4]);
  });

  it("counts a count of a role's grants as a read", () => {
    expect(
      unfilteredLines([
        'tx.role.findMany({ select: { _count: { select: { permissions: true } } } });',
        'tx.role.findMany({ select: { _count: { select: { permissions: { where: { revokedAt: null } } } } } });',
      ]),
    ).toEqual([1]);
  });

  it('sees through as const and satisfies around the select', () => {
    expect(
      unfilteredLines([
        'export const select = {',
        '  role: {',
        '    select: { permissions: { select: { id: true } } } as const,',
        '  },',
        '} as const satisfies Prisma.MemberSelect;',
      ]),
    ).toEqual([3]);
  });

  it("leaves out a user's permissions, a type and a permissions key read as false", () => {
    // `User.permissions` holds `UserPermission` rows, which no revocation
    // touches; a type literal is not a query; `false` reads nothing.
    expect(
      readLines([
        'tx.user.findUnique({ where: { id }, select: { permissions: { select: { id: true } } } });',
        'type Loaded = { role: { permissions: { id: string }[] } };',
        'tx.role.findMany({ select: { permissions: false } });',
      ]),
    ).toEqual([]);
  });

  it('reads Role relations from a Prisma schema, leaving out the model itself', () => {
    expect(
      [
        'model Role {',
        '  role   Role   @relation(fields: [roleId], references: [id])',
        '  invited Role?',
        '  roles Role[]',
        '  roleId String',
        '  kind SystemRole',
      ].map(roleRelationName),
    ).toEqual([undefined, 'role', 'invited', 'roles', undefined, undefined]);
  });

  it("skips only the reconciler's catalog directory, not every directory named catalog", () => {
    expect(skipsDir(RECONCILER_DIR)).toBe(true);
    expect(skipsDir(join(REPO_ROOT, 'libs/api/game/src/lib/catalog'))).toBe(false);
    expect(skipsDir(join(REPO_ROOT, 'libs/database/src/lib/generated'))).toBe(true);
  });
});
