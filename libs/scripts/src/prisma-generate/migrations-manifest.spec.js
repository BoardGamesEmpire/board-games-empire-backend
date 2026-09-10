'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listMigrationNames, renderMigrationsManifest, writeMigrationsManifest } = require('./migrations-manifest');

describe('migrations manifest', () => {
  let workspaceRoot;
  let migrationsDir;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bge-manifest-'));
    migrationsDir = path.join(workspaceRoot, 'prisma', 'migrations');
    fs.mkdirSync(migrationsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function addMigration(name, sql = 'SELECT 1;') {
    const dir = path.join(migrationsDir, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'migration.sql'), sql);
  }

  describe('listMigrationNames', () => {
    it('lists migration directories in name order, which is Prisma apply order', () => {
      addMigration('20260301205759_permissions');
      addMigration('20260109085042_init');
      addMigration('20260219032812_games');

      expect(listMigrationNames(migrationsDir)).toEqual([
        '20260109085042_init',
        '20260219032812_games',
        '20260301205759_permissions',
      ]);
    });

    it('ignores the lock file and any directory without a migration.sql', () => {
      addMigration('20260109085042_init');
      fs.writeFileSync(path.join(migrationsDir, 'migration_lock.toml'), 'provider = "postgresql"');
      fs.mkdirSync(path.join(migrationsDir, 'scratch'));

      expect(listMigrationNames(migrationsDir)).toEqual(['20260109085042_init']);
    });

    it('refuses a missing migrations directory rather than reporting an empty chain', () => {
      expect(() => listMigrationNames(path.join(workspaceRoot, 'nowhere'))).toThrow(/nowhere/);
    });
  });

  describe('renderMigrationsManifest', () => {
    it('renders a typed, readonly, generated TypeScript module', () => {
      const source = renderMigrationsManifest(['20260109085042_init', '20260219032812_games']);

      expect(source).toContain('AUTO-GENERATED');
      expect(source).toContain(
        "export const MIGRATION_NAMES: readonly string[] = [\n  '20260109085042_init',\n  '20260219032812_games',\n];",
      );
    });

    it('renders an empty chain as an empty array, not a syntax error', () => {
      expect(renderMigrationsManifest([])).toContain('export const MIGRATION_NAMES: readonly string[] = [];');
    });

    it('escapes a directory name that would otherwise end the string literal early', () => {
      // Prisma only reads the directory; nothing stops a hand-made name from
      // carrying a quote or a backslash, and the manifest must still compile.
      const names = ["20260910000000_owner's", '20260911000000_back\\slash'];
      const source = renderMigrationsManifest(names);

      const literal = /= (\[[\s\S]*\]);/.exec(source);
      expect(literal).not.toBeNull();
      expect(new Function(`return ${literal[1]}`)()).toEqual(names);
    });
  });

  describe('writeMigrationsManifest', () => {
    it('writes the manifest into the generated client directory and returns its path', () => {
      addMigration('20260109085042_init');
      fs.mkdirSync(path.join(workspaceRoot, 'libs', 'database', 'src', 'lib', 'generated'), { recursive: true });

      const written = writeMigrationsManifest(workspaceRoot);

      expect(written).toBe(
        path.join(workspaceRoot, 'libs', 'database', 'src', 'lib', 'generated', 'migrations-manifest.ts'),
      );
      expect(fs.readFileSync(written, 'utf8')).toContain("'20260109085042_init'");
    });
  });
});
