'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** Every file under `dir`, at any depth, that `predicate` accepts, sorted by path. */
function listFiles(dir, predicate) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    if (predicate(full)) found.push(full);
  }
  return found.sort();
}

module.exports = { listFiles };
