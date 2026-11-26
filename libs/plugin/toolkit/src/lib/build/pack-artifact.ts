import { PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES } from '@boardgamesempire/plugin-manifest';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, rename, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { Header, Pack } from 'tar-stream';
import { pack } from 'tar-stream';
import type { ArtifactEntry } from '../stage/artifact-entries.js';
import { ToolkitError } from '../toolkit.errors.js';

const FILE_MODE = 0o644;
const DIRECTORY_MODE = 0o755;

/** Where the gzip header names the operating system it was written on (RFC 1952). */
const GZIP_OS_OFFSET = 9;

/** RFC 1952's "unknown" operating system. */
const GZIP_OS_UNKNOWN = 0xff;

export interface PackedArtifact {
  readonly sha256: string;
}

export interface PackArtifactOptions {
  /**
   * Runs once the bytes are complete, just before they take `outFile`'s name,
   * and never when the write fails: the build removes an earlier checksum
   * file here, so a new plugin artifact never sits beside a stale checksum,
   * and a failed build leaves the earlier pair alone (#1093).
   */
  readonly beforeRename?: () => Promise<void>;

  /** The most bytes the plugin artifact may take, compressed: by default, the most a server accepts. */
  readonly maxBytes?: number;
}

/**
 * zlib writes no time into the gzip header, but it does write the operating
 * system it was built for: 19 on macOS, 3 on Linux, 10 on Windows. Pinning
 * that byte to "unknown" lets the same plugin built on two machines give the
 * same bytes, and so the same checksum (#1093).
 */
const pinGzipOperatingSystem = (): Transform => {
  let seen = 0;

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const start = seen;
      seen += chunk.length;

      if (start > GZIP_OS_OFFSET || seen <= GZIP_OS_OFFSET) {
        callback(null, chunk);
        return;
      }

      const pinned = Buffer.from(chunk);
      pinned[GZIP_OS_OFFSET - start] = GZIP_OS_UNKNOWN;
      callback(null, pinned);
    },
  });
};

/**
 * The header every entry gets, whoever builds the plugin and wherever (#1093):
 * a fixed time, no owner, and one mode for files and one for folders, so the
 * bytes depend only on the plugin's files.
 */
const headerFor = (entry: ArtifactEntry, mtime: Date): Header => ({
  devmajor: 0,
  devminor: 0,
  gid: 0,
  gname: '',
  linkname: '',
  mode: entry.type === 'directory' ? DIRECTORY_MODE : FILE_MODE,
  mtime,
  name: entry.archiveName,
  size: 0,
  type: entry.type,
  uid: 0,
  uname: '',
});

/**
 * Whether the write failed on its own account: the size limit, or a
 * filesystem error (which carries the failed `syscall`) such as a full disk.
 * Anything else is the write noticing that the archive was destroyed after
 * an entry failed.
 */
const isWriteFailure = (failure: unknown): boolean =>
  failure instanceof ToolkitError || (typeof failure === 'object' && failure !== null && 'syscall' in failure);

/** Adds one entry and resolves once tar-stream has taken all of it. */
const addEntry = async (archive: Pack, entry: ArtifactEntry, mtime: Date): Promise<void> => {
  const header = headerFor(entry, mtime);
  const body = entry.type === 'file' ? await readFile(entry.absolutePath) : undefined;

  await new Promise<void>((resolve, reject) => {
    const done = (error?: Error | null): void => (error ? reject(error) : resolve());

    if (body === undefined) {
      archive.entry(header, done);
    } else {
      archive.entry({ ...header, size: body.length }, body, done);
    }
  });
};

/**
 * Writes `entries`, in the order given, as a gzip-compressed tar at
 * `outFile`, and returns its SHA-256 (#1093). Every header carries
 * `mtimeSeconds`, uid and gid 0, no user or group name, and mode 0644 for a
 * file or 0755 for a folder, so the same entries always give the same bytes.
 *
 * The bytes go to `<outFile>.partial`, hashed as they stream, and are renamed
 * to `outFile` only once complete, so `outFile` is never half written. A
 * plugin artifact larger than `maxBytes` stops the write with
 * ARTIFACT_TOO_LARGE. On any failure the partial file is removed.
 */
export const packArtifact = async (
  entries: readonly ArtifactEntry[],
  outFile: string,
  mtimeSeconds: number,
  { beforeRename, maxBytes = PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES }: PackArtifactOptions = {},
): Promise<PackedArtifact> => {
  const partialFile = `${outFile}.partial`;
  const mtime = new Date(mtimeSeconds * 1000);
  const archive = pack();
  const hash = createHash('sha256');
  let size = 0;

  const hashAndCount = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;

      if (size > maxBytes) {
        callback(new ToolkitError('ARTIFACT_TOO_LARGE'));
        return;
      }

      hash.update(chunk);
      callback(null, chunk);
    },
  });

  // Runs alongside the loop below. A failure here destroys the archive, which
  // fails the entry being added; the rejection is awaited in the catch, so it
  // must not also escape as unhandled.
  const writing = pipeline(
    Readable.from(archive, { objectMode: false }),
    createGzip(),
    pinGzipOperatingSystem(),
    hashAndCount,
    createWriteStream(partialFile),
  );
  writing.catch(() => undefined);

  try {
    for (const entry of entries) {
      await addEntry(archive, entry, mtime);
    }

    archive.finalize();
    await writing;
    await beforeRename?.();
    await rename(partialFile, outFile);
  } catch (error) {
    archive.destroy();
    const writeFailure = await writing.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    await rm(partialFile, { force: true });

    // The write's own failure is what stopped the entry being added, so it is
    // the one reported.
    throw isWriteFailure(writeFailure) ? writeFailure : error;
  }

  return { sha256: hash.digest('hex') };
};
