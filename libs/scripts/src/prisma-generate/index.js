'use strict';
/**
 * Concurrency-safe `prisma generate`.
 *
 * `npm start` launches one `nx run <app>:serve:development` per Procfile line.
 * Those are separate Nx processes with separate task graphs, so each one runs
 * `@bge/database:generate` for itself, and the target is uncached on purpose
 * (see docs/NX_CACHING.md). Six concurrent `prisma generate` runs then race on
 * the single output directory, which the generator deletes and rewrites:
 *
 *   ENOTEMPTY: directory not empty, rmdir '.../generated/models'
 *   EEXIST: file already exists, mkdir '.../generated/models'
 *   .../generated exists and is not empty but doesn't look like a generated
 *   Prisma Client
 *
 * A whole-run lock would stop the collisions but not the harm: the winners
 * still rewrite the tree five more times while other apps' builds are reading
 * it, which is the same mid-write read that made i18n:test fail on a missing
 * ./internal/prismaNamespace.js. So the lock is paired with a fingerprint of
 * the generator's real inputs — whoever gets there first generates, everyone
 * else waits and then finds the client already current and does nothing.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { createClientState } = require('./client-state');
const { createLock } = require('./lock');

const workspaceRoot = path.resolve(__dirname, '..', '..', '..', '..');
const outputDir = path.join(workspaceRoot, 'libs', 'database', 'src', 'lib', 'generated');
const stateDir = path.join(workspaceRoot, 'node_modules', '.cache', 'prisma-generate');
const lockPath = path.join(stateDir, 'lock.json');

function runPrismaGenerate(args) {
  const bin = path.join(workspaceRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'prisma.cmd' : 'prisma');

  const result = spawnSync(bin, ['generate', ...args], {
    cwd: workspaceRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) throw result.error;

  return result.status ?? 1;
}

function reportIfCurrent(client, expectedFingerprint) {
  if (!client.isCurrent(expectedFingerprint)) return false;

  console.log('prisma generate: client is up to date, skipping');

  return true;
}

function main(args) {
  const client = createClientState(workspaceRoot);
  const expectedFingerprint = client.fingerprint();

  if (reportIfCurrent(client, expectedFingerprint)) return 0;

  fs.mkdirSync(stateDir, { recursive: true });

  const lock = createLock({ lockPath });
  lock.acquire();

  try {
    // The holder of the lock may have generated while we queued.
    if (reportIfCurrent(client, expectedFingerprint)) return 0;

    // The generator refuses a non-empty directory it does not recognise, which
    // is exactly the state an interrupted run leaves behind.
    fs.rmSync(outputDir, { recursive: true, force: true });

    const status = runPrismaGenerate(args);
    if (status !== 0) return status;

    client.writeStamp(expectedFingerprint);

    return 0;
  } finally {
    lock.release();
  }
}

module.exports = { main };
