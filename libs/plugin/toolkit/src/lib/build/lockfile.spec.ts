import { ToolkitError } from '../toolkit.errors.js';
import { parseLockfile } from './lockfile.js';

const thrownBy = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }

  return undefined;
};

describe('parseLockfile (#1093)', () => {
  it('reads an npm 7 or later lockfile, keeping the fields SOURCES.md needs', () => {
    const lockfile = parseLockfile(
      JSON.stringify({
        lockfileVersion: 3,
        name: 'demo-sink',
        packages: {
          '': { name: 'demo-sink', version: '1.2.0' },
          'node_modules/dice': {
            integrity: 'sha512-x',
            license: 'MIT',
            resolved: 'https://r/dice.tgz',
            version: '4.1.0',
          },
        },
      }),
    );

    expect(lockfile.packages['node_modules/dice']).toMatchObject({
      license: 'MIT',
      resolved: 'https://r/dice.tgz',
      version: '4.1.0',
    });
  });

  it('reads a license npm copied as an object from an old package.json as no license, not as a broken lockfile', () => {
    const lockfile = parseLockfile(
      JSON.stringify({
        lockfileVersion: 2,
        packages: { 'node_modules/old': { license: { name: 'MIT' }, version: '1.0.0' } },
      }),
    );

    expect(lockfile.packages['node_modules/old']?.license).toBeUndefined();
  });

  it.each<[string, unknown]>([
    ['lockfileVersion 1', { dependencies: {}, lockfileVersion: 1 }],
    ['no lockfileVersion', { packages: {} }],
    ['packages that is not an object', { lockfileVersion: 3, packages: [] }],
    ['a package entry that is not an object', { lockfileVersion: 3, packages: { 'node_modules/x': 'x' } }],
    ['a lockfile that is not an object', 'not a lockfile'],
  ])('refuses %s as LOCKFILE_UNSUPPORTED at package-lock.json', (_name, lockfile) => {
    const thrown = thrownBy(() => parseLockfile(JSON.stringify(lockfile)));

    expect(thrown).toBeInstanceOf(ToolkitError);
    expect(thrown).toMatchObject({ at: 'package-lock.json', code: 'LOCKFILE_UNSUPPORTED' });
  });

  it('refuses a lockfile that is not JSON as LOCKFILE_UNSUPPORTED at package-lock.json, and says why', () => {
    const thrown = thrownBy(() => parseLockfile('{ "lockfileVersion": '));

    expect(thrown).toBeInstanceOf(ToolkitError);
    expect(thrown).toMatchObject({
      at: 'package-lock.json',
      code: 'LOCKFILE_UNSUPPORTED',
      message: expect.stringContaining('not valid JSON'),
    });
  });
});
