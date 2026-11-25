import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stagePluginFiles } from './stage-plugin-files.js';

describe('stagePluginFiles (#1093)', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'bge-stage-plugin-files-'));
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  const makeProject = async (): Promise<{ intoDir: string; projectDir: string }> => {
    const projectDir = await mkdtemp(join(root, 'project-'));
    const intoDir = await mkdtemp(join(root, 'stage-'));

    await mkdir(join(projectDir, 'dist/nested'), { recursive: true });
    await writeFile(join(projectDir, 'package.json'), '{"name":"dice-tools"}');
    await writeFile(join(projectDir, 'dist/nested/index.js'), 'export {};');
    await writeFile(join(projectDir, 'left-out.js'), 'not selected');

    return { intoDir, projectDir };
  };

  it('copies only the selected files, creating their folders', async () => {
    const { intoDir, projectDir } = await makeProject();

    await stagePluginFiles(projectDir, ['dist/nested/index.js', 'package.json'], intoDir);

    expect((await readdir(intoDir)).sort()).toEqual(['dist', 'package.json']);
    await expect(readFile(join(intoDir, 'dist/nested/index.js'), 'utf8')).resolves.toBe('export {};');
    await expect(readFile(join(intoDir, 'package.json'), 'utf8')).resolves.toBe('{"name":"dice-tools"}');
  });

  it('refuses a selected file that is a symbolic link, naming it, rather than copying what it points to', async () => {
    const { intoDir, projectDir } = await makeProject();
    await symlink('left-out.js', join(projectDir, 'linked.js'));

    await expect(stagePluginFiles(projectDir, ['linked.js'], intoDir)).rejects.toMatchObject({
      at: 'linked.js',
      code: 'SYMLINK_REFUSED',
      name: 'ToolkitError',
    });
    await expect(readdir(intoDir)).resolves.toEqual([]);
  });

  // npm never lists such a path; the guard keeps a bad caller from reading or
  // writing outside the two folders (#1093).
  it.each([
    ['climbs out of both folders', '../outside.js'],
    ['climbs out after going in', 'dist/../../outside.js'],
    ['is absolute', '/etc/hosts'],
    ['names the folder itself', '.'],
  ])('refuses a path that %s, before copying anything', async (_case, path) => {
    const { intoDir, projectDir } = await makeProject();
    await writeFile(join(root, 'outside.js'), 'outside');

    await expect(stagePluginFiles(projectDir, ['package.json', path], intoDir)).rejects.toThrow(
      `cannot be staged: it lies outside`,
    );
    await expect(readdir(intoDir)).resolves.toEqual([]);
  });
});
