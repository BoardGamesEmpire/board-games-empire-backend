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

const { listFiles } = require('./list-files');
const { MANIFEST_FILE } = require('./migrations-manifest');
const { UNIT_ID_COLUMNS_FILE } = require('./unit-id-columns');

/**
 * The installed version of a package, from the first `<pkg>/package.json` on
 * Node's search path for it. Neither `require('<pkg>/package.json')` nor
 * resolving the entry point works for every package here:
 * `@prisma/get-dmmf`'s exports map leaves `./package.json` out, and
 * `prisma`'s names an entry file the package does not ship.
 */
function installedVersion(pkg) {
  for (const dir of require.resolve.paths(pkg) ?? []) {
    const manifest = path.join(dir, pkg, 'package.json');

    if (fs.existsSync(manifest)) return JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
  }

  throw new Error(`prisma generate: ${pkg} is not installed`);
}

function createClientState(workspaceRoot) {
  const schemaDir = path.join(workspaceRoot, 'prisma');
  const outputDir = path.join(workspaceRoot, 'libs', 'database', 'src', 'lib', 'generated');
  const stampFile = path.join(workspaceRoot, 'node_modules', '.cache', 'prisma-generate', 'stamp.json');

  /**
   * Everything that changes what this target writes: the schema, the config
   * that points at it, the code of these generate scripts, the versions of the
   * generator and of the schema parser that writes the unit-id columns (#994)
   * — and the migration directory
   * names, because the migrations manifest (#236) is written alongside the
   * client and a SQL-only migration changes it without touching any `.prisma`.
   * Names only: nothing generated reads a migration's body, so editing one in
   * place (routine before alpha) must not rebuild the client.
   */
  function fingerprint() {
    const hash = crypto.createHash('sha256');

    for (const file of listFiles(schemaDir, (f) => f.endsWith('.prisma'))) {
      hash.update(path.relative(workspaceRoot, file));
      hash.update(fs.readFileSync(file));
    }

    for (const file of listFiles(schemaDir, (f) => f.endsWith('.sql'))) {
      hash.update(path.relative(workspaceRoot, file));
    }

    hash.update(fs.readFileSync(path.join(workspaceRoot, 'prisma.config.ts')));

    // The generator's own code, the set the generate target's Nx inputs name:
    // the unit-id columns are derived by it, so an edit to it must rebuild them
    // (#994). Specs are left out, as there. A missing file or directory throws
    // rather than dropping out of the hash: a moved generator would otherwise
    // stop rebuilding the map without a word.
    const scriptsDir = path.join(workspaceRoot, 'libs', 'scripts', 'src');
    const generatorFiles = [
      ...listFiles(path.join(scriptsDir, 'prisma-generate'), (f) => f.endsWith('.js') && !f.endsWith('.spec.js')),
      path.join(scriptsDir, 'bin', 'prisma-generate.js'),
    ];

    for (const file of generatorFiles) {
      hash.update(path.relative(workspaceRoot, file));
      hash.update(fs.readFileSync(file));
    }

    for (const pkg of ['prisma', '@prisma/client', '@prisma/get-dmmf']) {
      hash.update(`${pkg}@${installedVersion(pkg)}`);
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
      fs.existsSync(path.join(outputDir, 'client.ts')) &&
      fs.existsSync(path.join(outputDir, MANIFEST_FILE)) &&
      fs.existsSync(path.join(outputDir, UNIT_ID_COLUMNS_FILE))
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
