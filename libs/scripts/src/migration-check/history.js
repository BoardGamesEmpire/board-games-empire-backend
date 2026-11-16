'use strict';
/**
 * Does this change remove or rename a migration already on master? (#1148)
 *
 * A database that applied a migration keeps its row in `_prisma_migrations`
 * under the directory's name. Rename or delete that directory and the next boot
 * finds a row no build knows. #586's replay (`db:migrate:check`) can't see it:
 * the renamed migrations still build the same schema. So this compares the
 * migration directories at a base commit with those in the working tree, by
 * name. In CI the working tree is the commit under test; locally it is what
 * `prisma migrate` would read, so a rename is caught before it is committed.
 *
 * The base is the merge base with `origin/master`, not the pull request's base
 * branch: a stacked pull request may rename a migration that exists only on
 * the branch below it, which no database outside a developer's own has
 * applied. A push to master passes the commit before the push instead.
 *
 * Editing a migration in place stays allowed (pre-alpha): only a directory
 * missing from the working tree fails.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = 'prisma/migrations';
const MIGRATION_FILE = /^prisma\/migrations\/([^/]+)\/migration\.sql$/;

/**
 * The environment without git's own variables. A git hook exports some of them
 * (`commit -a` exports GIT_INDEX_FILE), and git would then read that index or
 * repository instead of the one at `cwd`, as `spec-swcrc/check.js` explains.
 */
const ENV_WITHOUT_GIT = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));

function git(cwd, args, ref) {
  const result = spawnSync('git', args, { cwd, env: ENV_WITHOUT_GIT, encoding: 'utf8' });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit ${result.status}`;
    throw new Error(`git could not read ${ref}: ${detail}`);
  }

  return result.stdout;
}

/** The name of every directory under prisma/migrations that holds a migration.sql, sorted. */
function migrationNames(lsTreeOutput) {
  const names = [];

  for (const line of lsTreeOutput.split('\n')) {
    const match = MIGRATION_FILE.exec(line.trim());

    if (match) {
      names.push(match[1]);
    }
  }

  return names.sort();
}

/** The names in `base` that `head` lacks, sorted. */
function removedMigrations(base, head) {
  const kept = new Set(head);

  return base.filter((name) => !kept.has(name)).sort();
}

function migrationsAt(cwd, ref) {
  return migrationNames(git(cwd, ['ls-tree', '-r', '--name-only', `${ref}^{commit}`, '--', MIGRATIONS_DIR], ref));
}

/** The migrations in the working tree, read as `migrationsAt` reads a commit. */
function migrationsInWorkingTree(cwd) {
  const dir = path.join(cwd, MIGRATIONS_DIR);
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];

  return migrationNames(
    entries
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'migration.sql')))
      .map((entry) => `${MIGRATIONS_DIR}/${entry.name}/migration.sql`)
      .join('\n'),
  );
}

/**
 * Compares the migrations at `base` with those in the working tree. `base` defaults to
 * the merge base with `origin/master`. Throws, naming the ref, when git can't
 * resolve it: a shallow clone or a force-pushed `before` must fail the check,
 * never pass it.
 */
function checkMigrationHistory({ cwd, base }) {
  const resolvedBase = base || git(cwd, ['merge-base', 'origin/master', 'HEAD'], 'origin/master').trim();
  const removed = removedMigrations(migrationsAt(cwd, resolvedBase), migrationsInWorkingTree(cwd));

  return { base: resolvedBase, removed };
}

/** The failure text for migrations missing from this change. */
function describeRemoved(removed, base) {
  return [
    `${removed.length} migration(s) already on master are missing from this change (compared with ${base}):`,
    ...removed.map((name) => `  ${name}`),
    'A database that applied a migration keeps its row in _prisma_migrations, and the next boot finds a migration it does not know (#1148). ' +
      'Restore each one under its old name, and put a schema change in a new migration: `npm run db:migrate:new <name>`. ' +
      'A deliberate rewrite of the migration history removes this check from .github/workflows/ci.yml in its own pull request.',
  ].join('\n');
}

module.exports = { checkMigrationHistory, describeRemoved, migrationNames, removedMigrations };
