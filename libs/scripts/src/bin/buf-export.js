#!/usr/bin/env node
'use strict';
/**
 * Entrypoint for `@boardgamesempire/proto-gateway:buf-export`.
 *
 * Deliberately thin: exporting without ever leaving the directory part-written
 * lives in `proto-export/export.js`, where it is unit-testable (#313). This
 * file runs buf and reports.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { createLock } = require('../prisma-generate/lock');
const { exportProtos } = require('../proto-export/export');

const workspaceRoot = path.resolve(__dirname, '..', '..', '..', '..');
const protoRoot = path.join(workspaceRoot, 'libs', 'proto', 'gateway');

/**
 * Runs buf's npm launcher with Node itself, which needs no shell on any
 * platform. Through Windows' `buf.cmd` shim it took one, which splits the
 * command line at spaces, and both paths here are absolute (#313).
 */
function runBufExport(into) {
  const bin = path.join(path.dirname(require.resolve('@bufbuild/buf/package.json')), 'bin', 'buf');

  const result = spawnSync(process.execPath, [bin, 'export', 'src/proto', '--exclude-imports=false', '-o', into], {
    cwd: protoRoot,
    stdio: 'inherit',
  });

  if (result.error) throw result.error;

  return result.status ?? 1;
}

const cacheRoot = path.join(workspaceRoot, 'node_modules', '.cache');

try {
  const { status, written } = exportProtos({
    outputDir: path.join(protoRoot, 'proto-export'),
    stagingRoot: path.join(cacheRoot, 'proto-export'),
    runExport: runBufExport,
    lock: createLock({ lockPath: path.join(cacheRoot, 'proto-export.lock.json'), task: 'proto export' }),
  });

  if (status === 0) console.log(written ? 'buf export: wrote proto-export' : 'buf export: proto-export is up to date');
  process.exitCode = status;
} catch (error) {
  console.error(`buf export: ${error.message}`);
  process.exitCode = 1;
}
