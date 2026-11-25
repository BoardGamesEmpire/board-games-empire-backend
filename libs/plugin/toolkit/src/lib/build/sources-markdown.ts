import { isPlainJsonObject } from '@boardgamesempire/plugin-manifest';
import { compareBytewise } from '../stage/artifact-entries.js';
import { ToolkitError } from '../toolkit.errors.js';

const NODE_MODULES = 'node_modules/';

/** The first lockfile version with a `packages` map, written by npm 7 and later. */
const MIN_LOCKFILE_VERSION = 2;

interface SourceRow {
  readonly key: string;
  readonly license: string;
  readonly name: string;
  readonly source: string;
  readonly version: string;
}

/** `field` of a lockfile entry when it is a string, else `fallback`. */
const text = (entry: Record<string, unknown>, field: string, fallback: string): string => {
  const value = entry[field];

  return typeof value === 'string' ? value : fallback;
};

/**
 * A value as one table cell: a pipe would end the cell and a line break the
 * row, so the table keeps its structure for a screen reader as well as for
 * the eye (#1093).
 */
const cell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\s*\r?\n\s*/g, ' ');

/**
 * `SOURCES.md`, the list of the dependencies a plugin artifact carries, read
 * from its `package-lock.json` (#1093): one table row for each package npm
 * installed under `node_modules`, with its name, version, license and where
 * it came from, sorted by name. Development dependencies and packages
 * `isVendored` says were not installed (an optional dependency for another
 * system, say) are left out. A folder outside `node_modules`, which npm
 * records for a linked dependency, is the plugin author's own, not part of
 * the plugin artifact.
 *
 * The lockfile must be version 2 or later: version 1 has no `packages` map.
 */
export const renderSourcesMarkdown = (lockfile: unknown, isVendored: (lockPath: string) => boolean): string => {
  const lockfileVersion = isPlainJsonObject(lockfile) ? lockfile['lockfileVersion'] : undefined;
  const packages = isPlainJsonObject(lockfile) ? lockfile['packages'] : undefined;

  if (typeof lockfileVersion !== 'number' || lockfileVersion < MIN_LOCKFILE_VERSION || !isPlainJsonObject(packages)) {
    throw new ToolkitError('LOCKFILE_UNSUPPORTED');
  }

  const rows: SourceRow[] = [];

  for (const [key, entry] of Object.entries(packages)) {
    if (!key.startsWith(NODE_MODULES) || !isPlainJsonObject(entry) || entry['dev'] === true || !isVendored(key)) {
      continue;
    }

    rows.push({
      key,
      license: text(entry, 'license', 'unknown'),
      name: key.slice(key.lastIndexOf(NODE_MODULES) + NODE_MODULES.length),
      source: text(entry, 'resolved', 'local'),
      version: text(entry, 'version', 'unknown'),
    });
  }

  // By name, then by where npm installed it, so two versions of one
  // dependency always come out in the same order and the plugin artifact
  // stays byte-for-byte reproducible.
  rows.sort((a, b) => compareBytewise(a.name, b.name) || compareBytewise(a.key, b.key));

  const heading = '# Dependencies\n\n';

  if (rows.length === 0) {
    return `${heading}This plugin artifact has no dependencies installed in it.\n`;
  }

  return [
    `${heading}The dependencies installed in this plugin artifact, as its package-lock.json records them.\n`,
    '| Name | Version | License | Source |',
    '| --- | --- | --- | --- |',
    ...rows.map((row) => `| ${[row.name, row.version, row.license, row.source].map(cell).join(' | ')} |`),
    '',
  ].join('\n');
};
