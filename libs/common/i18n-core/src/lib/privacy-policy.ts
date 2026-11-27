import { createHash } from 'node:crypto';
import * as path from 'node:path';

/**
 * Directory holding the standard privacy policy, one `<language tag>.md` per
 * language (#934). It holds nothing else, so an operator can mount their own
 * policy files over it without hiding the translation catalogs or anything
 * else the server reads.
 *
 * Resolved from `__dirname`, which is this source directory under jest (swc,
 * unbundled) and the app's `dist` directory in a webpack bundle, where the api
 * copies `./privacy-policy` in as an asset.
 */
export const PRIVACY_POLICY_DIR = path.join(__dirname, 'privacy-policy');

/**
 * The sha256 of every standard privacy policy the server has shipped: by
 * language, then by the `updated` date in the file's front matter, taken over
 * the whole file as {@link readPolicyFile} reads it, front matter included
 * (#934). A file whose hash is pinned under its own language and date is the
 * standard privacy policy; any other file is the operator's.
 *
 * When a text changes, its `updated` date moves to that day, and the new date
 * is added here with the new hash. Earlier dates stay, so a copy of an earlier
 * standard text that an operator mounts still counts as standard.
 */
export const STANDARD_PRIVACY_POLICY_HASHES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  en: {
    '2026-11-18': '79cdb10cf8409e9b1331018a513d41a293806e8ee9a8facc76da790807719b61',
    '2026-11-19': '2b682d2ae41e66d0e98ad13fd1df1e3ed23bf71dd3daa6079192bd70f2b892e2',
    '2026-11-20': '8baa4d2679d758ab5912179ad526c1a14be3d00158645e3fe4aff93e89275114',
    '2026-11-26': '336d550b657d8eb093101d7b33dba0341ec649d5769cc3e495e5f02766331d4d',
  },
};

/** A byte order mark, which an editor may put at the start of a file. */
const BOM = String.fromCodePoint(0xfeff);

/**
 * The front matter a policy file starts with (#934): only the date its text
 * last changed. Line endings are LF by the time it is matched.
 */
const FRONT_MATTER = /^---\nupdated: (\d{4}-\d{2}-\d{2})\n---\n/;

/** Lines holding nothing but spaces or tabs, at the start of the text. */
const LEADING_BLANK_LINES = /^(?:[ \t]*\n)+/;

/** A privacy policy file, read (#934). */
export interface PolicyFileContents {
  /** The text after the front matter and the blank lines below it. */
  body: string;

  /** The sha256 of the whole file, front matter included, as read. */
  hash: string;

  /** The front matter's `updated` date as written, `YYYY-MM-DD`; not yet checked to be a real day. */
  updated: string;
}

/**
 * Reads a privacy policy file's front matter, body and hash (#934), or answers
 * null when it doesn't start with the front matter: `---\nupdated:
 * YYYY-MM-DD\n---\n`. A byte order mark is dropped and CRLF line endings read
 * as LF before anything else, the hash included, so a standard text saved by a
 * Windows editor, or checked out with CRLF line endings, is still standard.
 */
export function readPolicyFile(bytes: Buffer): PolicyFileContents | null {
  const decoded = bytes.toString('utf8');
  const text = (decoded.startsWith(BOM) ? decoded.slice(BOM.length) : decoded).replaceAll('\r\n', '\n');
  const frontMatter = FRONT_MATTER.exec(text);
  if (!frontMatter) {
    return null;
  }

  return {
    body: text.slice(frontMatter[0].length).replace(LEADING_BLANK_LINES, ''),
    hash: createHash('sha256').update(text).digest('hex'),
    updated: frontMatter[1],
  };
}

/** Whether a file read in a language is a standard privacy policy shipped for it, under its own date (#934). */
export function isStandardPrivacyPolicy(language: string, file: PolicyFileContents): boolean {
  return STANDARD_PRIVACY_POLICY_HASHES[language]?.[file.updated] === file.hash;
}
