'use strict';
/**
 * `buf export` for `proto-gateway:buf-export`, without ever leaving
 * `libs/proto/gateway/proto-export` part-written (#313).
 *
 * Every app build that bundles the .proto files copies them from that
 * directory, and reaches this export through `^generate`. `npm start` runs six
 * of those builds in six separate Nx processes, each with its own task graph,
 * so six exports start at once, as six Prisma generates did (#338,
 * docs/NX_CACHING.md). Emptying the directory and exporting into it let one
 * run delete the files another app's webpack was copying: sampled while six
 * such runs went, it held fewer than its 4 files a quarter of the time, and
 * often none.
 *
 * So each run exports into a fresh directory of its own, and moves that into
 * place only when the files differ. The first run to finish moves its export
 * in, and the rest find the same files there and write nothing, as does every
 * later build until a .proto changes. What stays open, only while an export is
 * actually changing: a build copying the directory, or a linter walking it, can
 * land between the delete and the rename that replace it, and a .proto edited
 * while runs are in flight can leave the older export in place until the next
 * build.
 *
 * The fresh directories sit under node_modules/.cache, as prisma-generate's
 * lock does. Beside the export, one appeared and vanished under `eslint .` in
 * proto-gateway, which failed on it. There, nothing walking a package finds
 * them, and they share the export's disk, as the rename needs.
 */
const fs = require('node:fs');
const path = require('node:path');

/** Tries at moving into place, when other runs keep moving theirs in first. */
const ATTEMPTS = 3;

/** Every file under `root`, by path relative to it, or null when it isn't all there. */
function readFiles(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(path.relative(root, full), fs.readFileSync(full));
    }
  };

  try {
    walk(root);
  } catch (error) {
    // Missing, or being replaced by another run while this one read it.
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return files;
}

function sameFiles(a, b) {
  const left = readFiles(a);
  const right = readFiles(b);
  if (!left || !right || left.size !== right.size) return false;

  for (const [file, content] of left) {
    if (!right.get(file)?.equals(content)) return false;
  }
  return true;
}

/** Moves `staging` to `outputDir`, unless that already holds the same files. Returns whether it moved. */
function moveIntoPlace(staging, outputDir) {
  for (let attempt = 1; ; attempt += 1) {
    if (sameFiles(staging, outputDir)) return false;

    fs.rmSync(outputDir, { recursive: true, force: true });
    try {
      fs.renameSync(staging, outputDir);
      return true;
    } catch (error) {
      // Another run moved its export in between the delete and the rename.
      const collided = error.code === 'ENOTEMPTY' || error.code === 'EEXIST';
      if (!collided || attempt === ATTEMPTS) throw error;
    }
  }
}

/**
 * Runs `runExport(dir)`, which exports into `dir` and returns buf's exit
 * status, against a fresh directory under `stagingRoot`, then moves the result
 * to `outputDir` if it differs. The fresh directory is gone afterwards either
 * way.
 */
function exportProtos({ outputDir, stagingRoot, runExport }) {
  fs.mkdirSync(stagingRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(stagingRoot, 'run-'));
  try {
    const status = runExport(staging);
    if (status !== 0) return { status, written: false };

    return { status: 0, written: moveIntoPlace(staging, outputDir) };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { exportProtos };
