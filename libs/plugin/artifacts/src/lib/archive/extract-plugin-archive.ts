import {
  createPluginArchiveChecker,
  PLUGIN_ARCHIVE_MAX_ENTRIES,
  PLUGIN_ARCHIVE_MAX_EXTRACTED_BYTES,
} from '@boardgamesempire/plugin-manifest';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { extract as createTarExtract } from 'tar-stream';
import { PluginArchiveRefusedError } from '../artifacts.errors';
import { isGzipMagic } from './gzip-magic';

export interface PluginArchiveExtraction {
  readonly entryCount: number;
  readonly extractedBytes: number;
}

/**
 * How many decompressed bytes the extractor will walk (#1094). Zero blocks and
 * pax headers are not entries, so neither the entry cap nor the extracted-size
 * cap sees them, and a small gzip could otherwise make the server walk
 * gigabytes. The bound is the extracted cap, plus 2 KiB of tar framing (header
 * block, padding, a pax record) for each entry the rules allow, plus 1 MiB for
 * the archive's end blocks and global headers.
 */
export const PLUGIN_ARCHIVE_MAX_DECOMPRESSED_BYTES =
  PLUGIN_ARCHIVE_MAX_EXTRACTED_BYTES + PLUGIN_ARCHIVE_MAX_ENTRIES * 2048 + 1024 * 1024;

export interface PluginArchiveExtractOptions {
  /** Lets a test use a small bound instead of generating gigabytes. */
  readonly maxDecompressedBytes?: number;
}

/** The hook can only tighten the bound: a non-finite or non-positive value is ignored. */
export const boundedDecompressedLimit = (requested: number | undefined): number =>
  requested !== undefined && Number.isFinite(requested) && requested > 0
    ? Math.min(requested, PLUGIN_ARCHIVE_MAX_DECOMPRESSED_BYTES)
    : PLUGIN_ARCHIVE_MAX_DECOMPRESSED_BYTES;

/** A write that hit something already there: the archive's fault, not the disk's. */
const COLLISION_CODES: ReadonlySet<string> = new Set(['EEXIST', 'ENOTDIR', 'EISDIR']);

/** A name the filesystem cannot hold is the archive's fault too. */
const NAME_TOO_LONG = 'ENAMETOOLONG';

const errorCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | null)?.code;

/**
 * A filesystem error carries the failed `syscall`; a zlib or tar error does
 * not. The first is not the archive's fault and must propagate as it is.
 */
const isFilesystemError = (err: unknown): boolean => typeof (err as NodeJS.ErrnoException | null)?.syscall === 'string';

const readHead = async (path: string): Promise<Buffer> => {
  const file = await open(path, 'r');
  try {
    const head = Buffer.alloc(2);
    const { bytesRead } = await file.read(head, 0, 2, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
};

/**
 * Extracts a plugin artifact (#1094) into `intoDir`, stripping its top-level
 * directory. The archive is untrusted: every header goes through the archive
 * checker before its body is read, and every file is written here, by name,
 * with `wx` so nothing is overwritten or followed through a link. Nothing an
 * archive says can write outside `intoDir`.
 *
 * The extractor owns its output. On any failure it removes everything it wrote,
 * `intoDir` included, before it rethrows, so a caller never sees half an
 * extraction.
 */
export const extractPluginArchive = async (
  archivePath: string,
  intoDir: string,
  options: PluginArchiveExtractOptions = {},
): Promise<PluginArchiveExtraction> => {
  if (!isGzipMagic(await readHead(archivePath))) {
    throw new PluginArchiveRefusedError('not-gzip');
  }

  try {
    await mkdir(intoDir, { recursive: true, mode: 0o755 });

    return await extractInto(archivePath, intoDir, boundedDecompressedLimit(options.maxDecompressedBytes));
  } catch (err) {
    // A failed cleanup must not replace the error that caused it.
    await rm(intoDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
};

const countDecompressed = (limit: number): Transform => {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      callback(seen > limit ? new PluginArchiveRefusedError('extracted-size') : null, chunk);
    },
  });
};

const extractInto = async (
  archivePath: string,
  intoDir: string,
  maxDecompressedBytes: number,
): Promise<PluginArchiveExtraction> => {
  const checker = createPluginArchiveChecker();
  const tar = createTarExtract();
  let entryCount = 0;
  let extractedBytes = 0;

  // Runs alongside the loop below. A failure surfaces there (the extract
  // stream is destroyed with it); the rejection here is only awaited at the
  // end, so it must not also escape as unhandled.
  const reading = pipeline(createReadStream(archivePath), createGunzip(), countDecompressed(maxDecompressedBytes), tar);
  reading.catch(() => undefined);

  try {
    for await (const entry of tar) {
      const { header } = entry;
      const verdict = checker.check({ name: header.name, type: header.type, size: header.size });

      if (!verdict.ok) {
        throw new PluginArchiveRefusedError(verdict.rule, verdict.entry);
      }

      entryCount += 1;
      extractedBytes += header.size;

      // The top-level directory's counterpart is `intoDir` itself.
      if (verdict.path === '') {
        entry.resume();
        continue;
      }

      const target = join(intoDir, verdict.path);

      try {
        if (verdict.kind === 'directory') {
          await mkdir(target, { recursive: true, mode: 0o755 });
          entry.resume();
          continue;
        }

        await mkdir(dirname(target), { recursive: true, mode: 0o755 });

        // An upstream failure (a zlib error, the decompression bound) destroys
        // `tar`, and with it the entry still being filled, while we awaited
        // mkdir. `pipeline` never settles on a source that is already
        // destroyed, so stop here and surface the upstream failure instead.
        // Only the entry is checked: `tar` is also destroyed after a normal
        // finish (an archive with no end blocks), when the entry holds its
        // whole body and pipes fine.
        if (entry.destroyed) {
          await reading;
          throw new PluginArchiveRefusedError('corrupt', header.name);
        }

        await pipeline(entry, createWriteStream(target, { flags: 'wx', mode: 0o644 }));
      } catch (err) {
        // A duplicate name, or a file and a directory at one path.
        if (isFilesystemError(err)) {
          const code = errorCode(err) ?? '';
          if (COLLISION_CODES.has(code)) {
            throw new PluginArchiveRefusedError('corrupt', header.name);
          }
          if (code === NAME_TOO_LONG) {
            throw new PluginArchiveRefusedError('unsafe-path', header.name);
          }
        }
        throw err;
      }
    }

    await reading;

    const finished = checker.finish();
    if (!finished.ok) {
      throw new PluginArchiveRefusedError(finished.rule, finished.entry);
    }

    return { entryCount, extractedBytes };
  } catch (err) {
    // Tear the streams down and let them settle before the caller removes
    // the directory they were writing into.
    tar.destroy();
    await reading.catch(() => undefined);

    if (err instanceof PluginArchiveRefusedError || isFilesystemError(err)) {
      throw err;
    }

    // A zlib or tar error: the archive is damaged.
    throw new PluginArchiveRefusedError('corrupt');
  }
};
