import { copyFile, lstat, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { ToolkitError } from '../toolkit.errors.js';

/** Whether `path` names something strictly inside `dir`. */
const isInside = (dir: string, path: string): boolean => {
  const fromDir = relative(dir, path);

  return fromDir !== '' && fromDir !== '..' && !fromDir.startsWith(`..${sep}`) && !isAbsolute(fromDir);
};

/**
 * Copies the selected `files` (relative to `projectDir`) into `intoDir`,
 * creating their folders, so the plugin artifact is built from a copy
 * (#1093). A symbolic link is refused rather than followed: copying it would
 * pack whatever it points to, maybe from outside the project, and a server
 * refuses a link inside an archive. Any other special file (a named pipe, a
 * socket) is refused the same way, since copying one can block or fail.
 *
 * npm never lists an absolute path or one that climbs out with `..`, but the
 * paths are checked before anything is copied, so a bad caller cannot read
 * from or write to outside the two folders.
 */
export const stagePluginFiles = async (
  projectDir: string,
  files: readonly string[],
  intoDir: string,
): Promise<void> => {
  const copies = files.map((file) => {
    const source = resolve(projectDir, file);
    const target = resolve(intoDir, file);

    if (isAbsolute(file) || !isInside(resolve(projectDir), source) || !isInside(resolve(intoDir), target)) {
      throw new Error(`${JSON.stringify(file)} cannot be staged: it lies outside the plugin's folder.`);
    }

    return { file, source, target };
  });

  for (const { file, source, target } of copies) {
    if (!(await lstat(source)).isFile()) {
      throw new ToolkitError('SYMLINK_REFUSED', file);
    }

    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
};
