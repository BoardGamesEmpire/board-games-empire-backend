#!/usr/bin/env node
'use strict';
/**
 * Entrypoint for the `.spec.swcrc` source-map check that CI's `main` job runs.
 *
 * Deliberately thin: the check lives in `spec-swcrc/check.js`, where it is
 * unit-testable (#524). This file only reports and sets the exit code.
 */
const path = require('node:path');

const { checkSpecSwcrc } = require('../spec-swcrc/check');

const workspaceRoot = path.resolve(__dirname, '..', '..', '..', '..');

try {
  const { checked, problems } = checkSpecSwcrc(workspaceRoot);

  if (problems.length === 0) {
    console.log(`spec-swcrc: all ${checked.length} .spec.swcrc files set sourceMaps to "inline"`);
  } else {
    for (const problem of problems) console.error(`spec-swcrc: ${problem}`);
    console.error(
      'spec-swcrc: coverage maps back to source lines only with "inline"; see libs/scripts/src/spec-swcrc/check.js',
    );
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`spec-swcrc: ${error.message}`);
  process.exitCode = 1;
}
