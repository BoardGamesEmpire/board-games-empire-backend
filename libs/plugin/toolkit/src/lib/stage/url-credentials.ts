import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { message } from '../messages.js';
import type { ReportItem } from '../report.js';

/**
 * The npm files a plugin artifact carries exactly as the plugin author wrote
 * them, and where npm records the URL a dependency was named by: package.json
 * as written, package-lock.json in each `resolved` and in the root entry's
 * dependency map (#1093).
 */
const METADATA_FILES = ['package.json', 'package-lock.json'] as const;

/** A URL npm or git fetches over the network: http(s), ssh or git, with or without a `git+` prefix. */
const NETWORK_URL = /^(?:git\+)?(?:https?|ssh):\/\/|^git:\/\//i;

/**
 * Whether `url` holds a user name or password. The `git` user a git-over-ssh
 * URL names is no secret, so it does not count (#1093).
 */
export const hasCredentials = (url: URL): boolean =>
  url.password !== '' || (url.username !== '' && url.username !== 'git');

const isCredentialUrl = (text: string): boolean => {
  if (!NETWORK_URL.test(text)) {
    return false;
  }

  try {
    return hasCredentials(new URL(text));
  } catch {
    return false;
  }
};

/**
 * The path, key by key, to the first string in `value` that is a URL with
 * credentials in it, or undefined when there is none.
 */
const firstCredentialPath = (value: unknown, path: readonly string[] = []): string[] | undefined => {
  if (typeof value === 'string') {
    return isCredentialUrl(value) ? [...path] : undefined;
  }

  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  for (const [key, child] of Object.entries(value)) {
    const found = firstCredentialPath(child, [...path, key]);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
};

/** A key as the report names it: package-lock.json keys the plugin's own entry by the empty string. */
const keyLabel = (key: string): string => (key === '' ? '(root)' : key);

const readJson = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // A missing or unreadable file has nothing to ship; other checks report it.
    return undefined;
  }
};

/**
 * One URL_CREDENTIALS_REFUSED error for each of package.json and
 * package-lock.json in `stageDir` that holds a URL with a user name or
 * password in it, pointing at the first one (#1093). Both files ship in the
 * plugin artifact as the plugin author wrote them, and npm copies a
 * dependency's URL into package-lock.json whole, so a token written into it
 * would ship to every server that installs the plugin. The build refuses
 * rather than rewriting either file. The report names where the URL is,
 * never the URL itself, so the token never reaches the report either.
 */
export const urlCredentialErrors = async (stageDir: string): Promise<ReportItem[]> => {
  const errors: ReportItem[] = [];

  for (const file of METADATA_FILES) {
    const path = firstCredentialPath(await readJson(join(stageDir, file)));

    if (path !== undefined) {
      errors.push({
        at: file,
        code: 'URL_CREDENTIALS_REFUSED',
        message: message('URL_CREDENTIALS_REFUSED', { field: path.map(keyLabel).join(' > ') }),
      });
    }
  }

  return errors;
};
