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

const { exportProtos } = require('../proto-export/export');

const workspaceRoot = path.resolve(__dirname, '..', '..', '..', '..');
const protoRoot = path.join(workspaceRoot, 'libs', 'proto', 'gateway');

function runBufExport(into) {
  const bin = path.join(workspaceRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'buf.cmd' : 'buf');

  const result = spawnSync(bin, ['export', 'src/proto', '--exclude-imports=false', '-o', into], {
    cwd: protoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) throw result.error;

  return result.status ?? 1;
}

try {
  const { status, written } = exportProtos({
    outputDir: path.join(protoRoot, 'proto-export'),
    stagingRoot: path.join(workspaceRoot, 'node_modules', '.cache', 'proto-export'),
    runExport: runBufExport,
  });

  if (status === 0) console.log(written ? 'buf export: wrote proto-export' : 'buf export: proto-export is up to date');
  process.exitCode = status;
} catch (error) {
  console.error(`buf export: ${error.message}`);
  process.exitCode = 1;
}
