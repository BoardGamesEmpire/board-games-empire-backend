'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkSpecSwcrc } = require('./check');

/**
 * The environment without git's own variables. Inside a git hook they point at
 * the real repository (`commit -a` exports its GIT_INDEX_FILE), and the fixtures
 * below would be staged there.
 */
const ENV_WITHOUT_GIT = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));

/** A trimmed `.spec.swcrc` in the Nx generator's shape, with `sourceMaps` swapped in. */
function swcrc(sourceMaps) {
  return JSON.stringify(
    {
      jsc: { target: 'es2017', parser: { syntax: 'typescript', decorators: true } },
      module: { type: 'es6' },
      sourceMaps,
      exclude: [],
    },
    null,
    2,
  );
}

describe('checkSpecSwcrc', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bge-spec-swcrc-'));
    git(['init', '--quiet']);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function git(args, options = {}) {
    return execFileSync('git', args, { cwd: root, env: ENV_WITHOUT_GIT, encoding: 'utf8', stdio: 'pipe', ...options });
  }

  function write(relativePath, contents) {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }

  /** Writes a file and stages it, as a committed project's config would be. */
  function track(relativePath, contents) {
    write(relativePath, contents);
    git(['add', '--', relativePath]);
  }

  it('passes when every .spec.swcrc sets sourceMaps to "inline"', () => {
    track('libs/a/.spec.swcrc', swcrc('inline'));
    track('apps/b/.spec.swcrc', swcrc('inline'));

    expect(checkSpecSwcrc(root)).toEqual({
      checked: ['apps/b/.spec.swcrc', 'libs/a/.spec.swcrc'],
      problems: [],
    });
  });

  it('flags sourceMaps: true, the value the Nx generator writes', () => {
    track('libs/a/.spec.swcrc', swcrc('inline'));
    track('libs/b/.spec.swcrc', swcrc(true));

    expect(checkSpecSwcrc(root).problems).toEqual(['libs/b/.spec.swcrc: sourceMaps is true; it must be "inline"']);
  });

  it('flags a missing sourceMaps key rather than trusting the @swc/jest default', () => {
    track('libs/a/.spec.swcrc', swcrc(undefined));

    expect(checkSpecSwcrc(root).problems).toEqual(['libs/a/.spec.swcrc: sourceMaps is not set; it must be "inline"']);
  });

  it('reports a file that is not JSON and still checks the rest', () => {
    // The jest configs read these with JSON.parse, so a trailing comma breaks them too.
    track('libs/a/.spec.swcrc', '{ "sourceMaps": "inline", }');
    track('libs/b/.spec.swcrc', swcrc(true));

    expect(checkSpecSwcrc(root).problems).toEqual([
      expect.stringMatching(/^libs\/a\/\.spec\.swcrc: not valid JSON \(.+\)$/),
      'libs/b/.spec.swcrc: sourceMaps is true; it must be "inline"',
    ]);
  });

  it('fails when it finds no .spec.swcrc at all, rather than passing with nothing checked', () => {
    expect(checkSpecSwcrc(root)).toEqual({
      checked: [],
      problems: ['no .spec.swcrc files found, so nothing was checked'],
    });
  });

  it('refuses a root below the top of its repository, which would check only part of the tree', () => {
    track('apps/b/.spec.swcrc', swcrc(true));
    track('libs/a/.spec.swcrc', swcrc('inline'));
    const libs = path.join(root, 'libs');

    expect(() => checkSpecSwcrc(libs)).toThrow(`${libs} is not the top of its git repository`);
  });

  it('checks an untracked file, so a freshly generated lib is caught before it is committed', () => {
    track('libs/a/.spec.swcrc', swcrc('inline'));
    write('libs/generated/.spec.swcrc', swcrc(true));

    expect(checkSpecSwcrc(root).problems).toEqual([
      'libs/generated/.spec.swcrc: sourceMaps is true; it must be "inline"',
    ]);
  });

  it('skips ignored files, such as a package that ships its own .spec.swcrc', () => {
    track('.gitignore', 'node_modules/\n');
    track('libs/a/.spec.swcrc', swcrc('inline'));
    write('node_modules/some-package/.spec.swcrc', swcrc(true));

    expect(checkSpecSwcrc(root)).toEqual({ checked: ['libs/a/.spec.swcrc'], problems: [] });
  });

  it('skips a tracked file deleted from the working tree, which no jest config can read', () => {
    track('libs/a/.spec.swcrc', swcrc('inline'));
    track('libs/removed/.spec.swcrc', swcrc(true));
    fs.rmSync(path.join(root, 'libs/removed/.spec.swcrc'));

    expect(checkSpecSwcrc(root)).toEqual({ checked: ['libs/a/.spec.swcrc'], problems: [] });
  });

  it('reports a file in a merge conflict once, not once per merge stage', () => {
    const file = 'libs/a/.spec.swcrc';
    write(file, `<<<<<<< ours\n${swcrc('inline')}\n=======\n${swcrc(true)}\n>>>>>>> theirs\n`);
    const blob = git(['hash-object', '-w', '--', file]).trim();
    const stages = [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\t${file}\n`).join('');
    git(['update-index', '--index-info'], { input: stages });

    expect(checkSpecSwcrc(root)).toEqual({
      checked: [file],
      problems: [expect.stringMatching(/^libs\/a\/\.spec\.swcrc: not valid JSON/)],
    });
  });

  it('leaves build .swcrc files alone, where sourceMaps: true writes the .map files', () => {
    track('libs/a/.spec.swcrc', swcrc('inline'));
    track('libs/a/.swcrc', swcrc(true));

    expect(checkSpecSwcrc(root)).toEqual({ checked: ['libs/a/.spec.swcrc'], problems: [] });
  });

  it('checks the repository at the root it is given, even when git hook variables point at another', () => {
    track('libs/a/.spec.swcrc', swcrc(true));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'bge-spec-swcrc-other-'));

    try {
      git(['init', '--quiet'], { cwd: other });
      // git inherits the caller's environment, so the check runs in a child process that has these set.
      const hookEnv = {
        ...ENV_WITHOUT_GIT,
        GIT_DIR: path.join(other, '.git'),
        GIT_WORK_TREE: other,
        GIT_INDEX_FILE: path.join(other, '.git', 'index'),
      };
      const run = `process.stdout.write(JSON.stringify(require(${JSON.stringify(require.resolve('./check'))}).checkSpecSwcrc(${JSON.stringify(root)})))`;
      const output = execFileSync(process.execPath, ['-e', run], { env: hookEnv, encoding: 'utf8', stdio: 'pipe' });

      expect(JSON.parse(output).problems).toEqual(['libs/a/.spec.swcrc: sourceMaps is true; it must be "inline"']);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
