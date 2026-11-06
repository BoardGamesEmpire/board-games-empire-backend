import { posix } from 'node:path';

/**
 * The rules a plugin artifact archive must meet (#1094). The server's
 * extractor calls these, and the plugin author CLI will call them too once it
 * is built (#84), so there is one list. Plain synchronous functions: the
 * caller owns the stream.
 */

export const PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES = 100 * 1024 * 1024;
export const PLUGIN_ARCHIVE_MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
export const PLUGIN_ARCHIVE_MAX_ENTRIES = 50_000;
/** The largest root `manifest.json` an archive may hold; the server reads the manifest into memory whole. */
export const PLUGIN_ARCHIVE_MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * The checker returns `entry-type`, `unsafe-path`, `top-level`, `entry-count`,
 * `extracted-size`, `manifest-size`, `required-file` and, for an entry whose
 * size is not a non-negative safe integer or whose path collides with an
 * earlier entry's, `corrupt`. The reader also reports `corrupt` for a damaged
 * stream; `not-gzip`, `compressed-size` and `manifest-slug` are for the reader
 * and the receiver to report. They all live here so the rules stay in one
 * list.
 */
export type PluginArchiveRule =
  | 'not-gzip'
  | 'corrupt'
  | 'entry-type'
  | 'unsafe-path'
  | 'top-level'
  | 'entry-count'
  | 'extracted-size'
  | 'compressed-size'
  | 'required-file'
  | 'manifest-slug'
  | 'manifest-size';

export interface PluginArchiveEntry {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

export type PluginArchiveRefusal = {
  readonly ok: false;
  readonly rule: PluginArchiveRule;
  /** The offending entry's name, where there is one. */
  readonly entry?: string;
};

/**
 * `path` is the entry's name with the top-level directory stripped. The
 * top-level directory's own entry gives an empty path: the extractor creates
 * nothing for it.
 */
export type PluginArchiveVerdict =
  | {
      readonly ok: true;
      readonly path: string;
      readonly kind: 'file' | 'directory';
    }
  | PluginArchiveRefusal;

export interface PluginArchiveChecker {
  check(entry: PluginArchiveEntry): PluginArchiveVerdict;
  finish(): { readonly ok: true } | PluginArchiveRefusal;
}

const MANIFEST_FILE = 'manifest.json';
const REQUIRED_FILES = ['package.json', MANIFEST_FILE] as const;

/**
 * Every path the accepted entries have made, so an entry that lands on one
 * can be refused (#1094). A deeper entry makes its parent directories too.
 * Each path is stored as a chain of segments keyed by the parent's id, so
 * checking an entry costs time in proportion to its name, however deep it is.
 */
const createArchivePaths = () => {
  const ROOT = 0;
  const ids = new Map<string, number>();
  const files = new Set<number>();
  const key = (parent: number, segment: string): string => `${parent}/${segment}`;

  return {
    /**
     * Whether an entry at `segments` lands on something an earlier entry
     * made: anything at all under or on a file, or a file where a directory
     * is. A directory named again is harmless.
     */
    collides(segments: readonly string[], kind: 'file' | 'directory'): boolean {
      let parent = ROOT;

      for (const [index, segment] of segments.entries()) {
        const id = ids.get(key(parent, segment));

        if (id === undefined) {
          return false;
        }
        if (files.has(id)) {
          return true;
        }
        if (index === segments.length - 1) {
          return kind === 'file';
        }

        parent = id;
      }

      return false;
    },

    record(segments: readonly string[], kind: 'file' | 'directory'): void {
      let parent = ROOT;

      for (const segment of segments) {
        const segmentKey = key(parent, segment);
        let id = ids.get(segmentKey);

        if (id === undefined) {
          id = ids.size + 1;
          ids.set(segmentKey, id);
        }

        parent = id;
      }

      if (kind === 'file' && segments.length > 0) {
        files.add(parent);
      }
    },
  };
};

export function createPluginArchiveChecker(): PluginArchiveChecker {
  let topLevel: string | undefined;
  let entries = 0;
  let extractedBytes = 0;
  const seenFiles = new Set<string>();
  const paths = createArchivePaths();

  const refuse = (rule: PluginArchiveRule, entry: string): PluginArchiveRefusal => ({
    ok: false,
    rule,
    entry,
  });

  return {
    check(entry) {
      const { name, type, size } = entry;

      if (type !== 'file' && type !== 'directory') {
        return refuse('entry-type', name);
      }

      // A NaN or negative size would poison the running total below.
      if (!Number.isSafeInteger(size) || size < 0) {
        return refuse('corrupt', name);
      }

      // Judged on the name as given: normalizing first would fold
      // `a/../../x` into something that looks harmless.
      if (
        name.startsWith('/') ||
        name.includes('\\') ||
        name.includes('\u0000') ||
        name.split('/').includes('..') ||
        // `package/package.json/` must not pass for the file itself.
        (type === 'file' && name.endsWith('/'))
      ) {
        return refuse('unsafe-path', name);
      }

      // Some tools write `./package/x`; a leading `./` is no prefix.
      const segments = posix
        .normalize(name)
        .split('/')
        .filter((segment) => segment !== '' && segment !== '.');
      const [top, ...rest] = segments;

      if (top === undefined || (rest.length === 0 && type !== 'directory')) {
        return refuse('top-level', name);
      }
      if (topLevel !== undefined && topLevel !== top) {
        return refuse('top-level', name);
      }

      // Two files at one path, a file and a directory at one path, or a path
      // under a file: the extractor would meet each on disk, and a checker
      // that writes nothing has to refuse it the same way.
      if (paths.collides(rest, type)) {
        return refuse('corrupt', name);
      }

      const path = rest.join('/');

      if (type === 'file' && path === MANIFEST_FILE && size > PLUGIN_ARCHIVE_MAX_MANIFEST_BYTES) {
        return refuse('manifest-size', name);
      }

      // Directory entries count too (each costs an extraction operation), the
      // top-level directory's own entry included.
      if (entries + 1 > PLUGIN_ARCHIVE_MAX_ENTRIES) {
        return refuse('entry-count', name);
      }

      const nextBytes = extractedBytes + size;
      if (nextBytes > PLUGIN_ARCHIVE_MAX_EXTRACTED_BYTES) {
        return refuse('extracted-size', name);
      }

      topLevel = top;
      entries += 1;
      extractedBytes = nextBytes;
      paths.record(rest, type);

      if (type === 'file') {
        seenFiles.add(path);
      }

      return { ok: true, path, kind: type };
    },

    finish() {
      for (const required of REQUIRED_FILES) {
        if (!seenFiles.has(required)) {
          return refuse('required-file', required);
        }
      }
      return { ok: true };
    },
  };
}
