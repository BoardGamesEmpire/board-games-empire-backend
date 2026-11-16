#!/usr/bin/env node
'use strict';
/**
 * Entrypoint for the BullMQ queue hash-tag check that CI's `main` job runs.
 *
 * Deliberately thin: the check lives in `queue-hash-tags/check.js`, where it is
 * unit-testable (#462). This file only reports and sets the exit code.
 */
const path = require('node:path');

const { checkQueueHashTags } = require('../queue-hash-tags/check');

const workspaceRoot = path.resolve(__dirname, '..', '..', '..', '..');

try {
  const { sites, problems } = checkQueueHashTags(workspaceRoot);

  if (problems.length === 0) {
    console.log(`queue-hash-tags: all ${sites.length} queue-name sites carry a hash tag`);
  } else {
    for (const problem of problems) {
      console.error(`queue-hash-tags: ${problem}`);
    }

    console.error(
      'queue-hash-tags: a Redis-compatible server that locks on hash tags rejects an unbraced queue; see libs/scripts/src/queue-hash-tags/check.js',
    );
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`queue-hash-tags: ${error.message}`);
  process.exitCode = 1;
}
