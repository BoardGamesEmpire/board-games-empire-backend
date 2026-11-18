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
 * the whole file's bytes, front matter included (#934). A file whose hash is
 * pinned under its own date is the standard privacy policy; any other file is
 * the operator's.
 *
 * When a text changes, its `updated` date moves to that day, and the new date
 * is added here with the new hash. Earlier dates stay, so a copy of an earlier
 * standard text that an operator mounts still counts as standard.
 */
export const STANDARD_PRIVACY_POLICY_HASHES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  en: {
    '2026-11-18': '79cdb10cf8409e9b1331018a513d41a293806e8ee9a8facc76da790807719b61',
  },
};
