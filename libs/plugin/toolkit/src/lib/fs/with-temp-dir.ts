import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Every temporary folder the CLI makes starts with this, under the OS temp folder. */
export const TEMP_DIR_PREFIX = 'bge-plugin-';

/**
 * Runs `use` with a new temporary folder under the OS temp folder and removes
 * the folder afterwards, whether `use` resolves or throws (#1093).
 */
export const withTempDir = async <T>(use: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));

  try {
    return await use(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};
