import { compareBytewise } from '../stage/artifact-entries.js';
import type { Lockfile } from './lockfile.js';

const NODE_MODULES = 'node_modules/';

/** What the Source column says for a dependency that came from the plugin author's own machine. */
const LOCAL_SOURCE = 'local';

/** What a column says where the lockfile records nothing. */
const UNKNOWN = 'unknown';

interface SourceRow {
  readonly key: string;
  readonly license: string;
  readonly name: string;
  readonly source: string;
  readonly version: string;
}

/**
 * A source worth printing: a registry or tarball URL over http(s), or a git
 * one (`git+ssh://`, `git+https://`, `git://`), which npm records with the
 * commit it installed. A `git+file:` URL is a folder on the plugin author's
 * machine, so it is not one of them (#1093).
 */
const REMOTE_SOURCE = /^(?:git\+)?(?:https?|ssh):\/\/|^git:\/\//i;

/**
 * The URL without any user name or password in it, except the `git` user a
 * git-over-ssh URL names: a token written into a dependency's URL must not
 * ship in the plugin artifact (#1093).
 */
const withoutCredentials = (resolved: string): string => {
  let url: URL;

  try {
    url = new URL(resolved);
  } catch {
    return LOCAL_SOURCE;
  }

  if (url.password === '' && (url.username === '' || url.username === 'git')) {
    return resolved;
  }

  url.username = '';
  url.password = '';

  return url.href;
};

/**
 * Where a dependency came from: a registry, tarball or git URL as npm
 * recorded it, or `local` for a `file:` one (a link, a `file:` path or any
 * bare path) or one with no record. npm counts a `file:` path from wherever
 * it installed, which in a build is a temporary folder under the plugin
 * author's home, so printing it would ship their folder names and make the
 * bytes depend on where the temporary folder is (#1093).
 */
const sourceOf = (entry: Lockfile['packages'][string]): string => {
  const { link, resolved } = entry;

  // npm 11 records a folder named by `file:` as a link whose `resolved` is a
  // bare relative path, with no `file:` prefix.
  if (link === true || resolved === undefined || !REMOTE_SOURCE.test(resolved)) {
    return LOCAL_SOURCE;
  }

  return withoutCredentials(resolved);
};

/**
 * The name a dependency is installed under, and for one installed under an
 * alias (`"http": "npm:undici@6.0.0"`), the package it really is, which npm
 * records as the entry's `name` (#1093).
 */
const nameOf = (key: string, entry: Lockfile['packages'][string]): string => {
  const installedAs = key.slice(key.lastIndexOf(NODE_MODULES) + NODE_MODULES.length);

  return entry.name === undefined || entry.name === installedAs ? installedAs : `${installedAs} (npm:${entry.name})`;
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
 */
export const renderSourcesMarkdown = (lockfile: Lockfile, isVendored: (lockPath: string) => boolean): string => {
  const rows: SourceRow[] = [];

  for (const [key, entry] of Object.entries(lockfile.packages)) {
    if (!key.startsWith(NODE_MODULES) || entry.dev === true || !isVendored(key)) {
      continue;
    }

    rows.push({
      key,
      license: entry.license ?? UNKNOWN,
      name: nameOf(key, entry),
      source: sourceOf(entry),
      version: entry.version ?? UNKNOWN,
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
