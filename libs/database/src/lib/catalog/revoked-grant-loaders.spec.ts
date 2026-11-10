import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

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
 * The readers live in projects that depend on this one, so the `test` target
 * hashes, through a runtime input, every `.ts` source under `libs/` and
 * `apps/` that mentions a permission: without that, a new reader elsewhere
 * leaves this target's hash alone, and CI restores the cached pass instead of
 * scanning it (docs/NX_CACHING.md). Every pattern below names a permission,
 * so a file the input leaves out has nothing to flag. A new pattern must name
 * one too, or the input must widen with it.
 */
const REPO_ROOT = join(__dirname, '../../../../..');
const SCANNED_ROOTS = ['libs', 'apps'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'out-tsc', 'generated', 'coverage']);
/**
 * The reconciler's directory: the one reader that must see revoked grants.
 * Skipped by path, so a `catalog` directory anywhere else is still scanned.
 */
const RECONCILER_DIR = join(REPO_ROOT, 'libs/database/src/lib/catalog');

/**
 * How far back from `permissions:`, its own line included, a `role:` key or a
 * call on the Role model (`tx.role.findMany(`) still makes it a role's relation.
 */
const ROLE_LOOKBACK = 8;
const ROLE_RELATION = /\brole:\s*\{|\brole\.\w+\(/;
/** How far on from `permissions:` its `where` must sit to count as its filter. */
const WHERE_LOOKAHEAD = 3;
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

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return skipsDir(path) ? [] : sourceFiles(path);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')
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

/**
 * Every read of a role's `permissions` relation in one file's source, as a
 * `select`, an `include` or `permissions: true`, and each unfiltered one. The
 * `select`/`where`/`include` key may follow `permissions: {` on its own line
 * or on the next. A type literal such as `permissions: { permission:
 * Permission }[]` has no such key after it, so it isn't a read.
 */
function scanSource(file: string, source: string): Scan {
  const reads: Read[] = [];
  const unfiltered: Read[] = [];
  const lines = source.split('\n');

  lines.forEach((text, index) => {
    const isTrue = /\bpermissions:\s*true\b/.test(text);
    const isInline = /\bpermissions:\s*\{\s*(where|select|include)\b/.test(text);
    const isBlock =
      /\bpermissions:\s*\{\s*$/.test(text) && /^\s*(where|select|include)\s*:/.test(lines[index + 1] ?? '');
    if (!isTrue && !isInline && !isBlock) {
      return;
    }

    const upTo = lines.slice(Math.max(0, index - ROLE_LOOKBACK), index + 1).join('\n');
    if (!ROLE_RELATION.test(upTo)) {
      return;
    }

    const read = { file, line: index + 1, text: text.trim() };
    reads.push(read);

    const after = lines.slice(index, index + 1 + WHERE_LOOKAHEAD).join('\n');
    if (isTrue || !/where:[^]*revokedAt:\s*null/.test(after)) {
      unfiltered.push(read);
    }
  });

  return { reads, unfiltered };
}

function scan(files: string[]): Scan {
  const scans = files.map((file) => scanSource(relative(REPO_ROOT, file), readFileSync(file, 'utf-8')));

  return { reads: scans.flatMap(({ reads }) => reads), unfiltered: scans.flatMap(({ unfiltered }) => unfiltered) };
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

  it('catches a read whose permissions select sits on one line', () => {
    expect(unfilteredLines(['role: {', '  select: { permissions: { select: { id: true } } },', '},'])).toEqual([2]);
    expect(
      unfilteredLines([
        'role: {',
        '  select: { permissions: { where: { revokedAt: null }, select: { id: true } } },',
        '},',
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

  it("skips only the reconciler's catalog directory, not every directory named catalog", () => {
    expect(skipsDir(RECONCILER_DIR)).toBe(true);
    expect(skipsDir(join(REPO_ROOT, 'libs/api/game/src/lib/catalog'))).toBe(false);
    expect(skipsDir(join(REPO_ROOT, 'libs/database/src/lib/generated'))).toBe(true);
  });
});
