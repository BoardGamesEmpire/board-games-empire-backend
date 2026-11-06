import {
  allocateIncoming,
  isGzipMagic,
  PluginArchiveRefusedError,
  PluginArtifactTooLargeError,
} from '@bge/plugin-artifacts';
import { PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES } from '@boardgamesempire/plugin-manifest';
import type { StorageEngine } from 'multer';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline, Transform, type Readable, type TransformCallback } from 'node:stream';
import { promisify } from 'node:util';

const pipelineAsync = promisify(pipeline);

/** What the controller reads from `req.file` once this storage has accepted an upload. */
export type PluginArtifactUploadedFile = Express.Multer.File & { readonly sha256: string };

const GZIP_MAGIC_BYTES = 2;

/**
 * Multer storage engine for a posted plugin artifact (#1094). It streams the
 * upload to `<pluginsRoot>/.incoming/<id>.tgz`, never to memory, hashing it and
 * counting it as it goes, so the file never has to be read again to be
 * checksummed and a client cannot fill the disk past the cap.
 *
 * `pluginsRoot` is used exactly as configured, never realpath'd: the receiver
 * compares `path.resolve` of the archive's directory with the configured
 * root's `.incoming/`, so a resolved symlink would be refused as outside it.
 *
 * Nothing is left behind on any failure: a file over the limit, bytes that are
 * not gzip, or a client that goes away mid-body all remove the partial file
 * before the callback runs, and the callback runs once.
 */
export class PluginArtifactUploadStorage implements StorageEngine {
  constructor(
    private readonly pluginsRoot: string,
    private readonly limitBytes: number = PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES,
  ) {}

  _handleFile(
    _req: unknown,
    file: Express.Multer.File,
    callback: (error?: unknown, info?: Partial<Express.Multer.File>) => void,
  ): void {
    this.store(file.stream).then(
      (stored) => callback(null, stored),
      (error: unknown) => callback(error),
    );
  }

  _removeFile(_req: unknown, file: Express.Multer.File, callback: (error: Error | null) => void): void {
    rm(file.path, { force: true }).then(
      () => callback(null),
      (error: Error) => callback(error),
    );
  }

  private async store(source: Readable): Promise<Partial<Express.Multer.File> & { sha256: string }> {
    const { archivePath } = await allocateIncoming(this.pluginsRoot);
    const hash = createHash('sha256');
    const gate = new UploadGate(this.limitBytes, hash);

    try {
      await pipelineAsync(source, gate, createWriteStream(archivePath));
    } catch (error) {
      await rm(archivePath, { force: true });
      throw error;
    }

    return { path: archivePath, size: gate.size, sha256: hash.digest('hex') };
  }
}

/**
 * Passes bytes through while it checks the first two for the gzip magic,
 * counts the total against the limit, and feeds the checksum.
 */
class UploadGate extends Transform {
  size = 0;
  private head = Buffer.alloc(0);
  private checked = false;

  constructor(
    private readonly limitBytes: number,
    private readonly hash: ReturnType<typeof createHash>,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.size += chunk.length;
    if (this.size > this.limitBytes) {
      callback(new PluginArtifactTooLargeError(this.limitBytes));
      return;
    }

    if (!this.checked) {
      this.head = Buffer.concat([this.head, chunk.subarray(0, GZIP_MAGIC_BYTES)]).subarray(0, GZIP_MAGIC_BYTES);
      if (this.head.length >= GZIP_MAGIC_BYTES) {
        if (!isGzipMagic(this.head)) {
          callback(new PluginArchiveRefusedError('not-gzip'));
          return;
        }
        this.checked = true;
      }
    }

    this.hash.update(chunk);
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    callback(this.checked ? null : new PluginArchiveRefusedError('not-gzip'));
  }
}
