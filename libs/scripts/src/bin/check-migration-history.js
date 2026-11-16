#!/usr/bin/env node
'use strict';
/**
 * Entrypoint for `npm run db:migrate:check-history`, which CI's `main` job
 * runs (#1148): does this change remove or rename a migration already on
 * master?
 *
 * Deliberately thin: the comparison lives in `migration-check/history.js`,
 * where it is unit-testable. `MIGRATION_HISTORY_BASE` names the commit to
 * compare with; unset or empty, it is the merge base with `origin/master`.
 * Exit codes follow `db:migrate:check`: 0 when nothing was removed, 2 when a
 * migration was, 1 on an error.
 */
const path = require('node:path');

const { checkMigrationHistory, describeRemoved } = require('../migration-check/history');

const workspaceRoot = path.resolve(__dirname, '..', '..', '..', '..');

try {
  const { base, removed } = checkMigrationHistory({
    cwd: workspaceRoot,
    base: process.env.MIGRATION_HISTORY_BASE || undefined,
  });

  if (removed.length > 0) {
    console.error(`db:migrate:check-history: ${describeRemoved(removed, base)}`);
    process.exitCode = 2;
  } else {
    console.log(`db:migrate:check-history: no migration on master was removed (compared with ${base}).`);
  }
} catch (error) {
  console.error(`db:migrate:check-history: ${error.message}`);
  process.exitCode = 1;
}
