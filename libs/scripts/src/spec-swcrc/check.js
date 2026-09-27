'use strict';
/**
 * Checks that every `.spec.swcrc` sets `"sourceMaps": "inline"` (#524).
 *
 * With `true`, unit-test coverage reports compiled-JS line numbers, so Codecov
 * marks the wrong source lines. @swc/jest returns that map as a JSON string.
 * Jest hands the string to istanbul unparsed, and istanbul copies it with an
 * object spread (`istanbul-lib-instrument/src/visitor.js`), which turns it into
 * an object of single characters. The remap then fails, and the only trace is a
 * line logged under `DEBUG=istanbuljs*`. With `"inline"` the map travels inside
 * the code, jest parses it into an object itself, and the remap works.
 *
 * Nx's generator writes `true` into every new project's `.spec.swcrc`, so a
 * one-off fix would not stay fixed. CI runs this over the whole tree instead.
 * The value must be exactly `"inline"`: @swc/jest also defaults a missing key
 * to inline, but a missing key can't be told apart from one nobody considered.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_SOURCE_MAPS = 'inline';

/**
 * The environment without git's own variables. A git hook exports some of them
 * (`commit -a` exports GIT_INDEX_FILE), and git would then read that index or
 * repository instead of the one at the root it was given.
 */
const ENV_WITHOUT_GIT = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));

/**
 * Tracked files plus untracked ones that aren't ignored, so a local run catches
 * a freshly generated lib before it is committed. The file name is spelled out,
 * which leaves build `.swcrc` files out; `:(glob)` lets `**` match no directory
 * at all, so a root file counts too. Merge stages are listed once per path.
 */
const LIST_SPEC_SWCRC_ARGS = [
  'ls-files',
  '-z',
  '--cached',
  '--others',
  '--exclude-standard',
  '--deduplicate',
  '--',
  ':(glob)**/.spec.swcrc',
];

function git(workspaceRoot, args) {
  // stderr is piped so a git failure surfaces once, in the thrown error, rather than twice.
  return execFileSync('git', args, {
    cwd: workspaceRoot,
    env: ENV_WITHOUT_GIT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function listSpecSwcrc(workspaceRoot) {
  // Below the top, `ls-files` lists only that subtree, and the check would pass on part of the tree.
  if (git(workspaceRoot, ['rev-parse', '--show-prefix']).trim() !== '') {
    throw new Error(`${workspaceRoot} is not the top of its git repository, so only part of the tree would be checked`);
  }

  const output = git(workspaceRoot, LIST_SPEC_SWCRC_ARGS);

  // The index still lists a file deleted from the working tree, which no jest config can read.
  return output
    .split('\0')
    .filter(Boolean)
    .filter((file) => fs.existsSync(path.join(workspaceRoot, file)));
}

function problemIn(workspaceRoot, file) {
  const contents = fs.readFileSync(path.join(workspaceRoot, file), 'utf8');

  let config;
  try {
    config = JSON.parse(contents);
  } catch (error) {
    return `${file}: not valid JSON (${error.message})`;
  }

  const sourceMaps = config?.sourceMaps;
  if (sourceMaps === REQUIRED_SOURCE_MAPS) return null;

  const found = sourceMaps === undefined ? 'not set' : JSON.stringify(sourceMaps);

  return `${file}: sourceMaps is ${found}; it must be "${REQUIRED_SOURCE_MAPS}"`;
}

/**
 * @param {string} workspaceRoot
 * @returns {{ checked: string[], problems: string[] }} the files checked, relative to
 *   `workspaceRoot`, and one message per file that fails. Finding no files at all is a problem too.
 */
function checkSpecSwcrc(workspaceRoot) {
  const checked = listSpecSwcrc(workspaceRoot);
  if (checked.length === 0) {
    return { checked, problems: ['no .spec.swcrc files found, so nothing was checked'] };
  }

  const problems = checked.map((file) => problemIn(workspaceRoot, file)).filter(Boolean);

  return { checked, problems };
}

module.exports = { checkSpecSwcrc };
