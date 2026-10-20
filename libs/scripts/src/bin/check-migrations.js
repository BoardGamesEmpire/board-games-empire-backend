#!/usr/bin/env node
'use strict';
/**
 * Entrypoint for `npm run db:migrate:check`, which CI's `main` job runs (#586):
 * do the migrations still build the schema the models describe?
 *
 * Deliberately thin: the shadow database check lives in
 * `migration-check/shadow-database.js`, where it is unit-testable. This file
 * loads `.env` the way prisma.config.ts does, refuses an unsafe shadow
 * database, then runs `prisma migrate diff`, in the shadow URL's schema, and
 * passes its exit code on: 0 when they match, 2 when they differ, 1 on an
 * error.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { migrateDiffEnv, shadowDatabaseProblem } = require('../migration-check/shadow-database');

const workspaceRoot = path.resolve(__dirname, '..', '..', '..', '..');

function runMigrateDiff(env) {
  const prismaCli = path.join(path.dirname(require.resolve('prisma/package.json')), 'build', 'index.js');
  const result = spawnSync(
    process.execPath,
    [prismaCli, 'migrate', 'diff', '--from-migrations', 'prisma/migrations', '--to-schema', 'prisma', '--exit-code'],
    { cwd: workspaceRoot, env, stdio: 'inherit' },
  );

  if (result.error) throw result.error;

  return result.status ?? 1;
}

try {
  require('dotenv').config({ path: path.join(workspaceRoot, '.env'), quiet: true });

  const problem = shadowDatabaseProblem(process.env);
  if (problem) {
    console.error(`db:migrate:check: ${problem}`);
    process.exitCode = 1;
  } else {
    process.exitCode = runMigrateDiff(migrateDiffEnv(process.env));
  }
} catch (error) {
  console.error(`db:migrate:check: ${error.message}`);
  process.exitCode = 1;
}
