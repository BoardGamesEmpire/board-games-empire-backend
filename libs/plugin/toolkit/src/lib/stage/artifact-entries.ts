import type { PluginArchiveRefusal } from '@boardgamesempire/plugin-manifest';
import { createPluginArchiveChecker } from '@boardgamesempire/plugin-manifest';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { message } from '../messages.js';
import type { ReportItem } from '../report.js';
import { ToolkitError } from '../toolkit.errors.js';

/** One entry the plugin artifact will hold, with the file on disk it comes from. */
export interface ArtifactEntry {
  readonly absolutePath: string;

  /** `<topLevel>/<path>`, with a trailing `/` on a directory. */
  readonly archiveName: string;

  readonly size: number;
  readonly type: 'directory' | 'file';
}

/**
 * Orders names by their UTF-8 bytes, as the plugin artifact's entries are
 * sorted (#1093). JavaScript's own string order compares UTF-16 code units,
 * which disagrees for characters past U+FFFF.
 */
export const compareBytewise = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/**
 * Where to point a plugin author at a link: the dependency that holds it, when
 * it is under `node_modules` (`node_modules/<name>` or
 * `node_modules/<@scope>/<name>`, the innermost for nested ones), since the
 * fix is in that dependency, not in one of its files. Otherwise the path
 * itself (#1093).
 */
const refusalLocation = (relativePath: string): string => {
  const segments = relativePath.split('/');
  // Only a `node_modules` with a name after it holds a dependency; a link
  // that is itself `node_modules` is named as it is.
  const last = segments.slice(0, -1).lastIndexOf('node_modules');

  if (last === -1) {
    return relativePath;
  }

  const name = segments[last + 1];
  const end = name.startsWith('@') && last + 2 < segments.length ? last + 3 : last + 2;

  return segments.slice(0, end).join('/');
};

/**
 * Every folder and file under `rootDir`, as the plugin artifact's entries:
 * the top-level folder first, then the rest sorted bytewise by archive name,
 * so a folder comes before its children (#1093). The walk never follows a
 * link: a symbolic link, or any entry that is neither a file nor a folder, is
 * refused, as the server refuses it in an archive.
 */
export const listArtifactEntries = async (rootDir: string, topLevel: string): Promise<readonly ArtifactEntry[]> => {
  const found: ArtifactEntry[] = [];

  const walk = async (relativeDir: string): Promise<void> => {
    const names = await readdir(relativeDir === '' ? rootDir : join(rootDir, relativeDir));

    for (const name of names) {
      const relativePath = relativeDir === '' ? name : `${relativeDir}/${name}`;
      const absolutePath = join(rootDir, relativePath);
      const stats = await lstat(absolutePath);

      if (stats.isDirectory()) {
        found.push({ absolutePath, archiveName: `${topLevel}/${relativePath}/`, size: 0, type: 'directory' });
        await walk(relativePath);
      } else if (stats.isFile()) {
        found.push({ absolutePath, archiveName: `${topLevel}/${relativePath}`, size: stats.size, type: 'file' });
      } else {
        throw new ToolkitError('SYMLINK_REFUSED', refusalLocation(relativePath));
      }
    }
  };

  await walk('');

  const keyed = found.map((entry) => ({ entry, key: Buffer.from(entry.archiveName) }));
  keyed.sort((a, b) => Buffer.compare(a.key, b.key));

  return [
    { absolutePath: rootDir, archiveName: `${topLevel}/`, size: 0, type: 'directory' },
    ...keyed.map(({ entry }) => entry),
  ];
};

const refusalItem = (refusal: PluginArchiveRefusal): ReportItem =>
  refusal.entry === undefined
    ? { code: refusal.rule, message: message(refusal.rule) }
    : { at: refusal.entry, code: refusal.rule, message: message(refusal.rule, { entry: refusal.entry }) };

/**
 * Runs the entries through the server's own archive checker (#1093, #1166),
 * so the CLI refuses exactly what a server would. Like the server, it stops
 * at the first refusal: the result is empty or holds one error.
 */
export const checkArtifactEntries = (entries: readonly ArtifactEntry[]): readonly ReportItem[] => {
  const checker = createPluginArchiveChecker();

  for (const { archiveName, size, type } of entries) {
    const verdict = checker.check({ name: archiveName, size, type });

    if (!verdict.ok) {
      return [refusalItem(verdict)];
    }
  }

  const finished = checker.finish();

  return finished.ok ? [] : [refusalItem(finished)];
};
