import { ToolkitError } from '../toolkit.errors.js';
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
        'node_modules/alpha': { license: 'MIT', resolved: 'file:../alpha-1.0.0.tgz', version: '1.0.0' },
      },
    };

    expect(tableRows(renderSourcesMarkdown(lockfile, everythingVendored))).toEqual([
      '| @dice/core | 2.0.0 | Apache-2.0 | local |',
      '| alpha | 1.0.0 | MIT | file:../alpha-1.0.0.tgz |',
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

  it.each<[string, unknown]>([
    ['lockfileVersion 1', { dependencies: {}, lockfileVersion: 1 }],
    ['no lockfileVersion', { packages: ROOT_PACKAGE }],
    ['packages that is not an object', { lockfileVersion: 3, packages: [] }],
    ['a lockfile that is not an object', 'not a lockfile'],
  ])('refuses %s as LOCKFILE_UNSUPPORTED', (_name, lockfile) => {
    let thrown: unknown;

    try {
      renderSourcesMarkdown(lockfile, everythingVendored);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ToolkitError);
    expect(thrown).toMatchObject({ code: 'LOCKFILE_UNSUPPORTED' });
  });
});
