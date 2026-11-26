import { lstat } from 'node:fs/promises';

/**
 * Whether a filesystem error says nothing is at the path: ENOENT, or ENOTDIR
 * for a path that runs through a file. Any other error (EACCES, say) is a
 * real failure and must reach the plugin author with its own words, not read
 * as "missing" (#1093). Read by its `code` alone: under Jest, Node's own
 * errors come from another realm and fail `instanceof Error`.
 */
export const isMissingPathError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error.code === 'ENOENT' || error.code === 'ENOTDIR');

/**
 * Whether `path` is a regular file, never following a link. Nothing at the
 * path is `false`; any other failure to look is thrown (#1093).
 */
export const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }

    throw error;
  }
};
