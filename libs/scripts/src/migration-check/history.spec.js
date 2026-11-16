'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkMigrationHistory, describeRemoved, migrationNames, removedMigrations } = require('./history');

/**
 * Without git's own variables: run inside a git hook, GIT_DIR or
 * GIT_INDEX_FILE would point these commands at the real repository instead of
 * the temp one, as in `spec-swcrc/check.spec.js`.
 */
const ENV_WITHOUT_GIT = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));

/**
 * Runs git in a temp repository. The global config signs commits, and a
 * signing prompt would hang the test, so signing is switched off here.
 */
function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
    cwd,
    env: ENV_WITHOUT_GIT,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }

  return result.stdout.trim();
}

function writeMigration(repo, name, sql = 'SELECT 1;\n') {
  const dir = path.join(repo, 'prisma', 'migrations', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'migration.sql'), sql);
}

function commitAll(repo, message) {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);

  return git(repo, 'rev-parse', 'HEAD');
}

describe('migration history check (#1148)', () => {
  describe('migrationNames', () => {
    it('keeps each directory holding a migration.sql and ignores every other file under prisma/migrations', () => {
      const output = [
        'prisma/migrations/20260109085042_init/migration.sql',
        'prisma/migrations/migration_lock.toml',
        'prisma/migrations/20260110_notes/README.md',
        'prisma/migrations/20260101000000_first/migration.sql',
        '',
      ].join('\n');

      expect(migrationNames(output)).toEqual(['20260101000000_first', '20260109085042_init']);
    });
  });

  describe('removedMigrations', () => {
    it('lists what the base has and the head lacks, ignoring additions', () => {
      expect(removedMigrations(['a', 'b', 'c'], ['a', 'c', 'd'])).toEqual(['b']);
    });
  });

  describe('describeRemoved', () => {
    it('names each missing migration, the base it compared with, and how to add a schema change instead', () => {
      const text = describeRemoved(['20260102_b'], 'abc1234');

      expect(text).toContain('20260102_b');
      expect(text).toContain('abc1234');
      expect(text).toContain('npm run db:migrate:new');
    });
  });

  describe('checkMigrationHistory, against a git repository', () => {
    let repo;
    let masterSha;

    beforeEach(() => {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bge-migration-history-'));
      git(repo, 'init', '-q', '-b', 'master');
      git(repo, 'config', 'user.name', 'Migration History Spec');
      git(repo, 'config', 'user.email', 'migration-history-spec@example.invalid');
      writeMigration(repo, '20260101_a');
      writeMigration(repo, '20260102_b');
      fs.writeFileSync(path.join(repo, 'prisma', 'migrations', 'migration_lock.toml'), 'provider = "postgresql"\n');
      masterSha = commitAll(repo, 'master');
      git(repo, 'update-ref', 'refs/remotes/origin/master', masterSha);
      git(repo, 'checkout', '-q', '-b', 'feature');
    });

    afterEach(() => {
      fs.rmSync(repo, { recursive: true, force: true });
    });

    it('passes a branch that only adds a migration', () => {
      writeMigration(repo, '20260103_c');
      commitAll(repo, 'add c');

      expect(checkMigrationHistory({ cwd: repo })).toEqual({ base: masterSha, removed: [] });
    });

    it('passes a branch that edits a migration in place, which pre-alpha allows', () => {
      writeMigration(repo, '20260102_b', 'SELECT 2;\n');
      commitAll(repo, 'edit b');

      expect(checkMigrationHistory({ cwd: repo }).removed).toEqual([]);
    });

    it('fails a branch that renames a migration on master, naming the old name', () => {
      git(repo, 'mv', 'prisma/migrations/20260102_b', 'prisma/migrations/20260102_b_renamed');
      commitAll(repo, 'rename b');

      expect(checkMigrationHistory({ cwd: repo }).removed).toEqual(['20260102_b']);
    });

    it('fails a branch that deletes a migration on master', () => {
      fs.rmSync(path.join(repo, 'prisma', 'migrations', '20260101_a'), { recursive: true });
      commitAll(repo, 'delete a');

      expect(checkMigrationHistory({ cwd: repo }).removed).toEqual(['20260101_a']);
    });

    it('fails a branch whose last migration.sql leaves a directory, though the directory keeps other files', () => {
      fs.writeFileSync(path.join(repo, 'prisma', 'migrations', '20260101_a', 'README.md'), 'notes\n');
      fs.rmSync(path.join(repo, 'prisma', 'migrations', '20260101_a', 'migration.sql'));
      commitAll(repo, 'empty a');

      expect(checkMigrationHistory({ cwd: repo }).removed).toEqual(['20260101_a']);
    });

    it('fails a rename not yet committed, so a local run catches it before CI does', () => {
      git(repo, 'mv', 'prisma/migrations/20260102_b', 'prisma/migrations/20260102_b_renamed');

      expect(checkMigrationHistory({ cwd: repo }).removed).toEqual(['20260102_b']);
    });

    it('passes a branch whose committed rename is restored in the working tree', () => {
      git(repo, 'mv', 'prisma/migrations/20260102_b', 'prisma/migrations/20260102_b_renamed');
      commitAll(repo, 'rename b');
      git(repo, 'mv', 'prisma/migrations/20260102_b_renamed', 'prisma/migrations/20260102_b');

      expect(checkMigrationHistory({ cwd: repo }).removed).toEqual([]);
    });

    it('passes a stacked branch renaming a migration that exists only on its base branch', () => {
      writeMigration(repo, '20260103_c');
      commitAll(repo, 'add c');
      git(repo, 'checkout', '-q', '-b', 'stacked');
      git(repo, 'mv', 'prisma/migrations/20260103_c', 'prisma/migrations/20260103_c_renamed');
      commitAll(repo, 'rename c');

      expect(checkMigrationHistory({ cwd: repo })).toEqual({ base: masterSha, removed: [] });
    });

    it('takes an explicit base, as a push to master passes github.event.before', () => {
      git(repo, 'checkout', '-q', 'master');
      const before = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'mv', 'prisma/migrations/20260101_a', 'prisma/migrations/20260101_a_renamed');
      commitAll(repo, 'rename a on master');

      expect(checkMigrationHistory({ cwd: repo, base: before })).toEqual({ base: before, removed: ['20260101_a'] });
    });

    it('throws naming a base it cannot resolve, rather than passing', () => {
      expect(() => checkMigrationHistory({ cwd: repo, base: 'deadbeef' })).toThrow(/deadbeef/);
    });

    it('throws naming origin/master when the clone lacks it, rather than passing', () => {
      git(repo, 'update-ref', '-d', 'refs/remotes/origin/master');

      expect(() => checkMigrationHistory({ cwd: repo })).toThrow(/origin\/master/);
    });

    it('throws naming origin/master when HEAD shares no history with it, rather than passing', () => {
      // git merge-base exits 1 with nothing on stderr for unrelated histories.
      git(repo, 'checkout', '-q', '--orphan', 'unrelated');
      commitAll(repo, 'unrelated root');

      expect(() => checkMigrationHistory({ cwd: repo })).toThrow(/origin\/master/);
    });
  });
});
