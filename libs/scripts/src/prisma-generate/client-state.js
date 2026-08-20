'use strict';
/**
 * Is the generated Prisma client already the one this schema would produce?
 *
 * The lock alone would be a regression dressed as a fix: six serialised runs
 * still rewrite the client five more times than necessary while other apps'
 * builds read it. The fingerprint is what makes those five no-ops.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function listFiles(dir, predicate) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    if (predicate(full)) found.push(full);
  }
  return found.sort();
}

function createClientState(workspaceRoot) {
  const schemaDir = path.join(workspaceRoot, 'prisma');
  const outputDir = path.join(workspaceRoot, 'libs', 'database', 'src', 'lib', 'generated');
  const stampFile = path.join(workspaceRoot, 'node_modules', '.cache', 'prisma-generate', 'stamp.json');

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

  function isCurrent(expectedFingerprint) {
    let stamp;
    try {
      stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
    } catch {
      return false;
    }

    return (
      stamp.fingerprint === expectedFingerprint &&
      stamp.fileCount > 0 &&
      stamp.fileCount === outputFileCount() &&
      fs.existsSync(path.join(outputDir, 'client.ts'))
    );
  }

  /**
   * Drop the stamp so no other invocation can believe the tree is current.
   *
   * Called before the tree is destroyed and rebuilt. The stamp is what the
   * unlocked fast path trusts, and a rebuild passes through a state that
   * satisfies it: the fingerprint has not changed, and a regenerating tree
   * momentarily reaches the recorded file count with `client.ts` present while
   * the last file is still being written. Clearing it first turns that fast path
   * into a wait on the lock.
   */
  function clearStamp() {
    fs.rmSync(stampFile, { force: true });
  }

  function writeStamp(expectedFingerprint) {
    fs.writeFileSync(stampFile, JSON.stringify({ fingerprint: expectedFingerprint, fileCount: outputFileCount() }));
  }

  return { fingerprint, isCurrent, clearStamp, writeStamp };
}

module.exports = { createClientState };
