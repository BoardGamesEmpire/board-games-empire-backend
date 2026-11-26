import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ToolkitError } from '../toolkit.errors.js';

export const LOCKFILE = 'package-lock.json';

/** The first lockfile version with a `packages` map, written by npm 7 and later. */
const MIN_LOCKFILE_VERSION = 2;

/**
 * One installed package in the lockfile's `packages` map, with the fields
 * SOURCES.md reads. npm records more, which is left alone (#1093, #1322).
 */
const lockfileEntrySchema = z.looseObject({
  dev: z.boolean().optional(),
  // npm copies a dependency's own license field, which an old package.json
  // can give as an object npm passes through: that reads as unknown.
  license: z.string().optional().catch(undefined),
  /** True where npm linked a folder dependency instead of copying it; its `resolved` is then a bare path. */
  link: z.boolean().optional().catch(undefined),
  /** The package's own name, which npm records where it differs from the folder: a dependency installed under an alias. */
  name: z.string().optional().catch(undefined),
  /** Where npm fetched the package from: a URL, or a path for a `file:` dependency. */
  resolved: z.string().optional(),
  version: z.string().optional(),
});

/**
 * The part of `package-lock.json` the build reads: a lockfile from npm 7 or
 * later, whose `packages` map is keyed by where each package is installed
 * (#1093, #1322).
 */
export const lockfileSchema = z.looseObject({
  lockfileVersion: z.number().int().min(MIN_LOCKFILE_VERSION),
  packages: z.record(z.string(), lockfileEntrySchema),
});

export type Lockfile = z.infer<typeof lockfileSchema>;

/**
 * The text of a `package-lock.json` as a lockfile the build can read, or
 * LOCKFILE_UNSUPPORTED at `package-lock.json` when it is not JSON or not in
 * that form (an npm 6 lockfile, say) (#1093).
 */
export const parseLockfile = (text: string): Lockfile => {
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    throw new ToolkitError('LOCKFILE_UNSUPPORTED', LOCKFILE, 'It is not valid JSON.');
  }

  const parsed = lockfileSchema.safeParse(json);

  if (!parsed.success) {
    throw new ToolkitError('LOCKFILE_UNSUPPORTED', LOCKFILE);
  }

  return parsed.data;
};

/** The `package-lock.json` in `dir`, read and parsed by `parseLockfile`. */
export const readLockfile = async (dir: string): Promise<Lockfile> =>
  parseLockfile(await readFile(join(dir, LOCKFILE), 'utf8'));
