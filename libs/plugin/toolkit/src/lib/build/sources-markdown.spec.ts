import { renderSourcesMarkdown } from './sources-markdown.js';

const ROOT_PACKAGE = { '': { name: 'demo-sink', version: '1.2.0' } };

const everythingVendored = (): boolean => true;

/** The table's body rows, without the header and its divider. */
const tableRows = (markdown: string): string[] =>
  markdown
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .slice(2);

describe('renderSourcesMarkdown (#1093)', () => {
  it('lists each installed production dependency with its version, license and where it came from', () => {
    const lockfile = {
      lockfileVersion: 3,
      packages: {
        ...ROOT_PACKAGE,
        'node_modules/dice-roller': {
          license: 'MIT',
          resolved: 'https://registry.npmjs.org/dice-roller/-/dice-roller-4.1.0.tgz',
          version: '4.1.0',
        },
        'node_modules/jest': {
          dev: true,
          license: 'MIT',
          resolved: 'https://registry.npmjs.org/jest/-/jest-30.0.0.tgz',
          version: '30.0.0',
        },
        'node_modules/native-dice': { license: 'ISC', optional: true, version: '1.0.0' },
      },
    };

    const markdown = renderSourcesMarkdown(lockfile, (key) => key !== 'node_modules/native-dice');

    expect(markdown).toMatch(/^# /);
    expect(markdown).toContain('| Name | Version | License | Source |');
    expect(tableRows(markdown)).toEqual([
      '| dice-roller | 4.1.0 | MIT | https://registry.npmjs.org/dice-roller/-/dice-roller-4.1.0.tgz |',
    ]);
  });

  it('names a nested or scoped dependency by its own name, sorted by name, with unknown and local where the lockfile is silent', () => {
    const lockfile = {
      lockfileVersion: 2,
      packages: {
        ...ROOT_PACKAGE,
        'node_modules/zebra': { version: '1.0.0' },
        'node_modules/zebra/node_modules/@dice/core': { license: 'Apache-2.0', version: '2.0.0' },
      },
    };

    expect(tableRows(renderSourcesMarkdown(lockfile, everythingVendored))).toEqual([
      '| @dice/core | 2.0.0 | Apache-2.0 | local |',
      '| zebra | 1.0.0 | unknown | local |',
    ]);
  });

  it("shows a file: dependency as local, never the path on the plugin author's machine (#1093)", () => {
    // npm records a `file:` path counted from wherever it installed, which in
    // a build is a temporary folder under the plugin author's home: printing
    // it would ship their folder names, and make the bytes depend on them.
    const lockfile = {
      lockfileVersion: 3,
      packages: {
        ...ROOT_PACKAGE,
        'node_modules/alpha': { license: 'MIT', resolved: 'file:../alpha-1.0.0.tgz', version: '1.0.0' },
        'node_modules/beta': {
          license: 'MIT',
          resolved: 'file:../../../../Users/someone/dice/beta-2.0.0.tgz',
          version: '2.0.0',
        },
      },
    };

    expect(tableRows(renderSourcesMarkdown(lockfile, everythingVendored))).toEqual([
      '| alpha | 1.0.0 | MIT | local |',
      '| beta | 2.0.0 | MIT | local |',
    ]);
  });

  it('shows a linked folder dependency, which npm 11 records as a bare relative path, as local (#1093)', () => {
    const lockfile = {
      lockfileVersion: 3,
      packages: {
        ...ROOT_PACKAGE,
        'node_modules/bare': { resolved: '../../Users/someone/dice/bare', version: '1.0.0' },
        'node_modules/linked': { link: true, resolved: '../dice/linked' },
        'node_modules/tarball': { resolved: 'https://example.com/tarball-1.0.0.tgz', version: '1.0.0' },
      },
    };

    expect(tableRows(renderSourcesMarkdown(lockfile, everythingVendored))).toEqual([
      '| bare | 1.0.0 | unknown | local |',
      '| linked | unknown | unknown | local |',
      '| tarball | 1.0.0 | unknown | https://example.com/tarball-1.0.0.tgz |',
    ]);
  });

  it('shows where a git dependency came from, with the commit npm installed (#1093)', () => {
    const lockfile = {
      lockfileVersion: 3,
      packages: {
        ...ROOT_PACKAGE,
        'node_modules/over-https': { resolved: 'git+https://github.com/dice/over-https.git#abc123', version: '1.0.0' },
        'node_modules/over-ssh': { resolved: 'git+ssh://git@github.com/dice/over-ssh.git#def456', version: '2.0.0' },
        'node_modules/in-a-folder': { resolved: 'git+file:///Users/someone/dice/in-a-folder#0a1b2c', version: '3.0.0' },
      },
    };

    expect(tableRows(renderSourcesMarkdown(lockfile, everythingVendored))).toEqual([
      '| in-a-folder | 3.0.0 | unknown | local |',
      '| over-https | 1.0.0 | unknown | git+https://github.com/dice/over-https.git#abc123 |',
      '| over-ssh | 2.0.0 | unknown | git+ssh://git@github.com/dice/over-ssh.git#def456 |',
    ]);
  });

  it('never ships a token or password written into a dependency URL (#1093)', () => {
    const lockfile = {
      lockfileVersion: 3,
      packages: {
        ...ROOT_PACKAGE,
        'node_modules/private': { resolved: 'git+https://ghp_secret@github.com/dice/private.git#abc123' },
        'node_modules/tarball': { resolved: 'https://someone:hunter2@example.com/tarball-1.0.0.tgz' },
      },
    };

    const markdown = renderSourcesMarkdown(lockfile, everythingVendored);

    expect(markdown).not.toMatch(/ghp_secret|someone|hunter2/);
    expect(tableRows(markdown)).toEqual([
      '| private | unknown | unknown | git+https://github.com/dice/private.git#abc123 |',
      '| tarball | unknown | unknown | https://example.com/tarball-1.0.0.tgz |',
    ]);
  });

  it('names a dependency installed under an alias with the package it really is (#1093)', () => {
    const lockfile = {
      lockfileVersion: 3,
      packages: {
        ...ROOT_PACKAGE,
        'node_modules/http': {
          license: 'MIT',
          name: 'undici',
          resolved: 'https://registry.npmjs.org/undici/-/undici-6.0.0.tgz',
          version: '6.0.0',
        },
        'node_modules/zebra': { name: 'zebra', version: '1.0.0' },
      },
    };

    expect(tableRows(renderSourcesMarkdown(lockfile, everythingVendored))).toEqual([
      '| http (npm:undici) | 6.0.0 | MIT | https://registry.npmjs.org/undici/-/undici-6.0.0.tgz |',
      '| zebra | 1.0.0 | unknown | local |',
    ]);
  });

  it('keeps the table intact when a lockfile field holds a pipe or a line break', () => {
    const lockfile = {
      lockfileVersion: 3,
      packages: { ...ROOT_PACKAGE, 'node_modules/odd': { license: 'MIT|ISC\nextra', version: '1.0.0' } },
    };

    expect(tableRows(renderSourcesMarkdown(lockfile, everythingVendored))).toEqual([
      '| odd | 1.0.0 | MIT\\|ISC extra | local |',
    ]);
  });

  it("lists only packages installed under node_modules, never a folder elsewhere on the plugin author's machine", () => {
    const lockfile = {
      lockfileVersion: 3,
      packages: { ...ROOT_PACKAGE, '../dice-roller': { license: 'MIT', version: '4.1.0' } },
    };

    const markdown = renderSourcesMarkdown(lockfile, everythingVendored);

    expect(markdown).not.toContain('dice-roller');
  });

  it('says the plugin artifact holds no dependencies when nothing was installed', () => {
    const markdown = renderSourcesMarkdown({ lockfileVersion: 3, packages: ROOT_PACKAGE }, everythingVendored);

    expect(markdown).toMatch(/^# /);
    expect(markdown).toContain('no dependencies');
    expect(markdown).not.toContain('|');
  });
});
