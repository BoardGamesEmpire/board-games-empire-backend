#!/usr/bin/env node
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
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const workspaceRoot = path.resolve(__dirname, '..');
const schemaDir = path.join(workspaceRoot, 'prisma');
const outputDir = path.join(workspaceRoot, 'libs', 'database', 'src', 'lib', 'generated');
const stateDir = path.join(workspaceRoot, 'node_modules', '.cache', 'prisma-generate');
const stampFile = path.join(stateDir, 'stamp.json');
const lockDir = path.join(stateDir, 'lock');

/** How long to wait for another process's generate before giving up. */
const LOCK_TIMEOUT_MS = 120_000;
/** A lock whose owner is gone and which has not been touched in this long is stale. */
const LOCK_STALE_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 100;

function listFiles(dir, predicate) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    if (predicate(full)) found.push(full);
  }
  return found.sort();
}

/**
 * Everything that changes what `prisma generate` writes: the schema, the
 * config that points at it, and the generator's own version.
 */
function fingerprint() {
  const hash = crypto.createHash('sha256');

  for (const file of listFiles(schemaDir, (f) => f.endsWith('.prisma'))) {
    hash.update(path.relative(workspaceRoot, file));
    hash.update(fs.readFileSync(file));
  }

  hash.update(fs.readFileSync(path.join(workspaceRoot, 'prisma.config.ts')));

  for (const pkg of ['prisma', '@prisma/client']) {
    hash.update(`${pkg}@${require(`${pkg}/package.json`).version}`);
  }

  return hash.digest('hex');
}

/**
 * File count is a cheap integrity check on top of the fingerprint: a tree that
 * was partially deleted, or restored short by a cache, no longer matches what
 * the recorded run wrote.
 */
function outputFileCount() {
  if (!fs.existsSync(outputDir)) return 0;
  return listFiles(outputDir, () => true).length;
}

function isCurrent(expected) {
  let stamp;
  try {
    stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
  } catch {
    return false;
  }

  return (
    stamp.fingerprint === expected &&
    stamp.fileCount > 0 &&
    stamp.fileCount === outputFileCount() &&
    fs.existsSync(path.join(outputDir, 'client.ts'))
  );
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** A lock is stale when its owner died, or when it outlived any plausible run. */
function clearIfStale() {
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
  } catch {
    // No readable owner record — only reclaim once it is old enough that no
    // live process could still be mid-write.
    const age = Date.now() - fs.statSync(lockDir).mtimeMs;
    if (age > LOCK_STALE_MS) fs.rmSync(lockDir, { recursive: true, force: true });
    return;
  }

  if (!processAlive(owner.pid) || Date.now() - owner.acquiredAt > LOCK_STALE_MS) {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

/** `mkdir` is the atomic primitive here: exactly one caller can create the dir. */
function tryAcquire() {
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }

  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
  );

  return true;
}

function sleep(ms) {
  // Synchronous by design: this runs before any generate work, and a blocking
  // wait keeps the whole script a straight line with no unhandled-rejection
  // paths around the lock.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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

function main() {
  const args = process.argv.slice(2);
  const expected = fingerprint();

  if (isCurrent(expected)) {
    console.log('prisma generate: client is up to date, skipping');
    return 0;
  }

  fs.mkdirSync(stateDir, { recursive: true });

  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (!tryAcquire()) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${LOCK_TIMEOUT_MS}ms waiting for another prisma generate to finish. ` +
          `If nothing is running, remove ${path.relative(workspaceRoot, lockDir)}.`,
      );
    }

    clearIfStale();
    sleep(POLL_INTERVAL_MS);
  }

  try {
    // The holder of the lock may have generated while we queued.
    if (isCurrent(expected)) {
      console.log('prisma generate: client is up to date, skipping');
      return 0;
    }

    // The generator refuses a non-empty directory it does not recognise, which
    // is exactly the state an interrupted run leaves behind.
    fs.rmSync(outputDir, { recursive: true, force: true });

    const status = runPrismaGenerate(args);
    if (status !== 0) return status;

    fs.writeFileSync(stampFile, JSON.stringify({ fingerprint: expected, fileCount: outputFileCount() }));

    return 0;
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`prisma generate: ${error.message}`);
  process.exitCode = 1;
}
