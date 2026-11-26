import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { urlCredentialErrors } from './url-credentials.js';

const SECRET = 's3cr3t';

describe('urlCredentialErrors (#1093)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bge-url-credentials-spec-'));
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  const write = async (files: Readonly<Record<string, unknown>>): Promise<void> => {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
    }
  };

  it('refuses a lockfile that records a dependency URL with a password, as npm writes one, naming where it is', async () => {
    await write({
      'package-lock.json': {
        lockfileVersion: 3,
        packages: {
          '': { name: 'p' },
          'node_modules/dep': { resolved: `https://alice:${SECRET}@registry.example/dep/-/dep-1.0.0.tgz` },
        },
      },
    });

    expect(await urlCredentialErrors(dir)).toEqual([
      {
        at: 'package-lock.json',
        code: 'URL_CREDENTIALS_REFUSED',
        message: expect.stringContaining('"packages > node_modules/dep > resolved"'),
      },
    ]);
  });

  it('refuses a token given as the user name of a git+https dependency in package.json', async () => {
    await write({ 'package.json': { dependencies: { dep: 'git+https://ghp_token@github.com/o/dep.git' } } });

    expect(await urlCredentialErrors(dir)).toEqual([
      {
        at: 'package.json',
        code: 'URL_CREDENTIALS_REFUSED',
        message: expect.stringContaining('"dependencies > dep"'),
      },
    ]);
  });

  it.each([
    ['a space before it', ` https://alice:${SECRET}@git.example/r.git`],
    ['a tab before it and a line break after it', `\thttps://alice:${SECRET}@git.example/r.git\n`],
  ])('refuses a URL with a password and %s, which the URL parser drops', async (_label, url) => {
    await write({ 'package.json': { repository: { type: 'git', url } } });

    expect(await urlCredentialErrors(dir)).toEqual([
      { at: 'package.json', code: 'URL_CREDENTIALS_REFUSED', message: expect.stringContaining('"repository > url"') },
    ]);
  });

  it('reports each file once, at its first such URL', async () => {
    await write({
      'package-lock.json': { packages: { '': { dependencies: { dep: `http://a:${SECRET}@h/x.tgz` } } } },
      'package.json': {
        dependencies: { dep: `http://a:${SECRET}@h/x.tgz` },
        repository: { url: `https://a:${SECRET}@h/r.git` },
      },
    });

    const errors = await urlCredentialErrors(dir);

    expect(errors.map((item) => item.at)).toEqual(['package.json', 'package-lock.json']);
    expect(errors[1]?.message).toContain('"packages > (root) > dependencies > dep"');
  });

  it('never puts the URL, or its credentials, in the report', async () => {
    await write({ 'package.json': { dependencies: { dep: `https://alice:${SECRET}@registry.example/dep.tgz` } } });

    const [error] = await urlCredentialErrors(dir);

    expect(error?.message).not.toContain(SECRET);
    expect(error?.message).not.toContain('alice');
  });

  it.each([
    ['the git user of a git-over-ssh URL', 'git+ssh://git@github.com/o/dep.git#abc123'],
    ['a URL with no user at all', 'https://registry.npmjs.org/dep/-/dep-1.0.0.tgz'],
    ['a version range', '^1.2.0'],
    ['a file: path', 'file:/home/me/dep-1.0.0.tgz'],
    ['an e-mail address', 'Alice <alice@example.com>'],
    ['an scp-style git address npm cannot parse as a URL', 'git+ssh://git@github.com:o/dep.git'],
  ])('allows %s', async (_label, spec) => {
    await write({ 'package.json': { author: spec, dependencies: { dep: spec } } });

    expect(await urlCredentialErrors(dir)).toEqual([]);
  });

  it('finds nothing in a file that is missing or not JSON, which other checks report', async () => {
    await write({ 'package.json': `{ "dependencies": { "dep": "https://a:${SECRET}@h/x.tgz"` });

    expect(await urlCredentialErrors(dir)).toEqual([]);
  });
});
