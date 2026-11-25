import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ArtifactEntry } from './artifact-entries.js';
import { checkArtifactEntries, listArtifactEntries } from './artifact-entries.js';

const TOP = 'dice-tools-1.0.0';

describe('plugin artifact entries (#1093)', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'bge-artifact-entries-'));
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  const writeTree = async (files: Readonly<Record<string, string>>): Promise<string> => {
    const stageDir = await mkdtemp(join(root, 'stage-'));

    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(stageDir, path)), { recursive: true });
      await writeFile(join(stageDir, path), content);
    }

    return stageDir;
  };

  describe('listArtifactEntries', () => {
    it('lists the top-level folder first, then every folder before its children, sorted bytewise and prefixed', async () => {
      const stageDir = await writeTree({
        'a-b/z.js': 'z',
        'a/b.js': 'bb',
        'B.md': 'B',
        'manifest.json': '{}',
        'package.json': '{"name":"dice-tools"}',
      });

      const entries = await listArtifactEntries(stageDir, TOP);

      expect(entries.map(({ archiveName, size, type }) => ({ archiveName, size, type }))).toEqual([
        { archiveName: `${TOP}/`, size: 0, type: 'directory' },
        { archiveName: `${TOP}/B.md`, size: 1, type: 'file' },
        { archiveName: `${TOP}/a-b/`, size: 0, type: 'directory' },
        { archiveName: `${TOP}/a-b/z.js`, size: 1, type: 'file' },
        { archiveName: `${TOP}/a/`, size: 0, type: 'directory' },
        { archiveName: `${TOP}/a/b.js`, size: 2, type: 'file' },
        { archiveName: `${TOP}/manifest.json`, size: 2, type: 'file' },
        { archiveName: `${TOP}/package.json`, size: 21, type: 'file' },
      ]);
      expect(entries[0].absolutePath).toBe(stageDir);
      expect(entries[5].absolutePath).toBe(join(stageDir, 'a', 'b.js'));
    });

    it('sorts by UTF-8 bytes, not by UTF-16 code units, as the archive is written', async () => {
      // U+FF21 is one UTF-16 unit and three UTF-8 bytes (EF BC A1); U+1F3B2 is
      // a surrogate pair (D83C …) but four bytes starting F0, so the two
      // orders disagree on them.
      const stageDir = await writeTree({ '\u{1F3B2}.txt': 'd', 'Ａ.txt': 'a' });

      const entries = await listArtifactEntries(stageDir, TOP);

      expect(entries.map(({ archiveName }) => archiveName)).toEqual([
        `${TOP}/`,
        `${TOP}/Ａ.txt`,
        `${TOP}/\u{1F3B2}.txt`,
      ]);
    });

    it('refuses a symbolic link inside a vendored dependency, naming the scoped dependency', async () => {
      const stageDir = await writeTree({ 'node_modules/@scope/pkg/lib/real.js': 'x', 'package.json': '{}' });
      await symlink('real.js', join(stageDir, 'node_modules/@scope/pkg/lib/x.js'));

      await expect(listArtifactEntries(stageDir, TOP)).rejects.toMatchObject({
        at: 'node_modules/@scope/pkg',
        code: 'SYMLINK_REFUSED',
        name: 'ToolkitError',
      });
    });

    it('names the innermost dependency for a link in a nested node_modules', async () => {
      const stageDir = await writeTree({ 'node_modules/a/node_modules/b/real': 'x', 'package.json': '{}' });
      await symlink('real', join(stageDir, 'node_modules/a/node_modules/b/x'));

      await expect(listArtifactEntries(stageDir, TOP)).rejects.toMatchObject({
        at: 'node_modules/a/node_modules/b',
        code: 'SYMLINK_REFUSED',
      });
    });

    it('names node_modules itself when that folder is the link', async () => {
      const stageDir = await writeTree({ 'deps/a/index.js': 'x', 'package.json': '{}' });
      await symlink('deps', join(stageDir, 'node_modules'));

      await expect(listArtifactEntries(stageDir, TOP)).rejects.toMatchObject({
        at: 'node_modules',
        code: 'SYMLINK_REFUSED',
      });
    });

    it("names the plugin's own path for a link outside node_modules", async () => {
      const stageDir = await writeTree({ 'dist/real.js': 'x', 'package.json': '{}' });
      await symlink('real.js', join(stageDir, 'dist/index.js'));

      await expect(listArtifactEntries(stageDir, TOP)).rejects.toMatchObject({
        at: 'dist/index.js',
        code: 'SYMLINK_REFUSED',
      });
    });
  });

  describe('checkArtifactEntries', () => {
    it("reports the server's required-file refusal for a staged tree without manifest.json", async () => {
      const stageDir = await writeTree({ 'index.js': 'export {};', 'package.json': '{}' });

      const items = checkArtifactEntries(await listArtifactEntries(stageDir, TOP));

      expect(items).toEqual([
        {
          at: 'manifest.json',
          code: 'required-file',
          message: 'The plugin artifact has no "manifest.json" in its top-level folder, and every plugin needs one.',
        },
      ]);
    });

    it('finds nothing wrong with a tree the server would accept', async () => {
      const stageDir = await writeTree({ 'manifest.json': '{}', 'package.json': '{}' });

      expect(checkArtifactEntries(await listArtifactEntries(stageDir, TOP))).toEqual([]);
    });

    // A name the disk itself would refuse, so the entries are built by hand
    // rather than written out (#1166).
    const entry = (archiveName: string, size = 1): ArtifactEntry => ({
      absolutePath: `/nowhere/${archiveName}`,
      archiveName,
      size,
      type: archiveName.endsWith('/') ? 'directory' : 'file',
    });

    it('refuses a file name over 255 UTF-8 bytes as unsafe-path, as the server does (#1166)', () => {
      // 128 two-byte characters: 256 bytes, though only 128 characters long.
      const longName = `${TOP}/${'é'.repeat(128)}`;

      expect(
        checkArtifactEntries([
          entry(`${TOP}/`),
          entry(longName),
          entry(`${TOP}/manifest.json`),
          entry(`${TOP}/package.json`),
        ]),
      ).toEqual([{ at: longName, code: 'unsafe-path', message: expect.stringContaining('is too long') }]);
    });

    it('stops at the first refusal, as the server does', () => {
      const items = checkArtifactEntries([entry(`${TOP}/`), entry(`${TOP}/../escape.js`), entry('elsewhere/x.js')]);

      expect(items).toEqual([{ at: `${TOP}/../escape.js`, code: 'unsafe-path', message: expect.any(String) }]);
    });
  });
});
