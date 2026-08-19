#!/usr/bin/env node
'use strict';
/**
 * Entrypoint for the concurrency-safe `prisma generate` wrapper.
 *
 * Deliberately thin: the lock, the fingerprint, and the orchestration live in
 * `prisma-generate/` where they are unit-testable (#338). This file exists
 * so `libs/database:generate` keeps a stable path to invoke under bare `node`.
 */
const { main } = require('../prisma-generate');

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`prisma generate: ${error.message}`);
  process.exitCode = 1;
}
