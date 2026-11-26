import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isFile, isMissingPathError } from './is-file.js';

describe('isFile (#1093)', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'bge-is-file-spec-'));
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('is true for a file and false for a folder', async () => {
    await writeFile(join(root, 'package.json'), '{}\n');

    await expect(isFile(join(root, 'package.json'))).resolves.toBe(true);
    await expect(isFile(root)).resolves.toBe(false);
  });

  it('is false when nothing is there, or the path runs through a file', async () => {
    await expect(isFile(join(root, 'no-such-file'))).resolves.toBe(false);
    await expect(isFile(join(root, 'package.json', 'inside'))).resolves.toBe(false);
  });

  // Root reads any folder, so the denial cannot be set up as root.
  const runsAsRoot = process.getuid?.() === 0;

  (runsAsRoot ? it.skip : it)(
    'passes on a failure to look, such as a folder it may not read, instead of calling the file missing (#1093)',
    async () => {
      const locked = join(root, 'locked');
      await mkdir(locked);
      await writeFile(join(locked, 'package-lock.json'), '{}\n');
      await chmod(locked, 0o000);

      try {
        await expect(isFile(join(locked, 'package-lock.json'))).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        await chmod(locked, 0o755);
      }
    },
  );
});

describe('isMissingPathError (#1093)', () => {
  it.each([
    ['ENOENT', true],
    ['ENOTDIR', true],
    ['EACCES', false],
    ['EISDIR', false],
  ])('%s is %s', (code, missing) => {
    expect(isMissingPathError(Object.assign(new Error(code), { code }))).toBe(missing);
  });

  it.each([undefined, null, 'ENOENT', new Error('ENOENT')])('is false for %p, which carries no code', (value) => {
    expect(isMissingPathError(value)).toBe(false);
  });
});
