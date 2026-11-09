import { PluginArchiveRefusedError, PluginArtifactTooLargeError } from '@bge/plugin-artifacts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { PluginArtifactUploadStorage, type PluginArtifactUploadedFile } from './plugin-artifact-upload.storage';

const GZIP_HEAD = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);

const handle = (storage: PluginArtifactUploadStorage, stream: Readable, mimetype = 'application/gzip') =>
  new Promise<PluginArtifactUploadedFile>((done, fail) => {
    const file = { fieldname: 'file', originalname: 'a.tgz', mimetype, stream } as Express.Multer.File;
    let calls = 0;
    storage._handleFile({} as never, file, (error, info) => {
      calls += 1;
      if (calls > 1) {
        fail(new Error('the callback ran twice'));
        return;
      }
      if (error) fail(error);
      else done(info as PluginArtifactUploadedFile);
    });
  });

describe('PluginArtifactUploadStorage (#1094)', () => {
  let root: string;
  const incoming = () => join(root, '.incoming');
  const leftovers = () => (existsSync(incoming()) ? readdirSync(incoming()) : []);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bge-upload-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('streams to the plugins volume and reports the checksum (#1094)', async () => {
    const body = Buffer.concat([GZIP_HEAD, Buffer.from('the rest of the artifact')]);
    const storage = new PluginArtifactUploadStorage(root);

    const info = await handle(storage, Readable.from([body.subarray(0, 7), body.subarray(7)]));

    expect(resolve(info.path, '..')).toBe(resolve(root, '.incoming'));
    expect(info.path.endsWith('.tgz')).toBe(true);
    expect(info.size).toBe(body.length);
    expect(info.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(readFileSync(info.path).equals(body)).toBe(true);
  });

  it('accepts a file of exactly the limit and refuses one a byte over (#1094)', async () => {
    const storage = new PluginArtifactUploadStorage(root, 1024);
    const atLimit = Buffer.concat([GZIP_HEAD, Buffer.alloc(1024 - GZIP_HEAD.length)]);

    const info = await handle(storage, Readable.from([atLimit]));
    expect(info.size).toBe(1024);

    await expect(handle(storage, Readable.from([Buffer.concat([atLimit, Buffer.from([0])])]))).rejects.toThrow(
      PluginArtifactTooLargeError,
    );
  });

  it('refuses a file over a 1 KiB limit with PluginArtifactTooLargeError and removes it (#1094)', async () => {
    const storage = new PluginArtifactUploadStorage(root, 1024);
    const chunks = [GZIP_HEAD, Buffer.alloc(600), Buffer.alloc(600)];

    const error = await handle(storage, Readable.from(chunks)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PluginArtifactTooLargeError);
    expect((error as PluginArtifactTooLargeError).limitBytes).toBe(1024);
    expect(leftovers()).toEqual([]);
  });

  it('refuses bytes that are not gzip whatever the declared type (#1094)', async () => {
    const storage = new PluginArtifactUploadStorage(root);

    const error = await handle(storage, Readable.from([Buffer.from('PK\x03\x04rest')]), 'application/gzip').catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(PluginArchiveRefusedError);
    expect((error as PluginArchiveRefusedError).rule).toBe('not-gzip');
    expect(leftovers()).toEqual([]);
  });

  it('waits for the second byte when the first chunk holds one (#1094)', async () => {
    const storage = new PluginArtifactUploadStorage(root);

    const info = await handle(storage, Readable.from([Buffer.from([0x1f]), Buffer.from([0x8b, 0x08])]));

    expect(info.size).toBe(3);
  });

  it('refuses a file shorter than two bytes, and an empty one (#1094)', async () => {
    const storage = new PluginArtifactUploadStorage(root);

    await expect(handle(storage, Readable.from([Buffer.from([0x1f])]))).rejects.toMatchObject({ rule: 'not-gzip' });
    await expect(handle(storage, Readable.from([]))).rejects.toMatchObject({ rule: 'not-gzip' });
    expect(leftovers()).toEqual([]);
  });

  it('removes the partial file when the client goes away mid-upload (#1094)', async () => {
    const storage = new PluginArtifactUploadStorage(root);
    const source = new PassThrough();
    const pending = handle(storage, source);
    source.write(Buffer.concat([GZIP_HEAD, Buffer.alloc(100)]));
    await new Promise((r) => setTimeout(r, 20));

    source.destroy(new Error('aborted'));

    await expect(pending).rejects.toThrow('aborted');
    expect(leftovers()).toEqual([]);
  });

  it('removes the partial file when the stream closes before it ends (#1094)', async () => {
    const storage = new PluginArtifactUploadStorage(root);
    const source = new PassThrough();
    const pending = handle(storage, source);
    source.write(Buffer.concat([GZIP_HEAD, Buffer.alloc(100)]));
    await new Promise((r) => setTimeout(r, 20));

    source.destroy();

    await expect(pending).rejects.toThrow();
    expect(leftovers()).toEqual([]);
  });

  it('writes under a plugins root that is itself a symlink, keeping the root as configured (#1094)', async () => {
    const real = mkdtempSync(join(tmpdir(), 'bge-upload-real-'));
    const link = join(root, 'link');
    symlinkSync(real, link);
    const storage = new PluginArtifactUploadStorage(link);

    try {
      const info = await handle(storage, Readable.from([GZIP_HEAD]));

      expect(resolve(info.path, '..')).toBe(resolve(link, '.incoming'));
      expect(existsSync(join(real, '.incoming', info.path.split('/').pop() as string))).toBe(true);
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it('removes the file on _removeFile, and a missing file is fine (#1094)', async () => {
    const storage = new PluginArtifactUploadStorage(root);
    const info = await handle(storage, Readable.from([GZIP_HEAD]));
    const remove = () =>
      new Promise<void>((done, fail) =>
        storage._removeFile({} as never, info, (error) => (error ? fail(error) : done())),
      );

    await remove();
    expect(existsSync(info.path)).toBe(false);
    await expect(remove()).resolves.toBeUndefined();
  });

  it('hands multer the error when _removeFile cannot remove the path (#1094)', async () => {
    const storage = new PluginArtifactUploadStorage(root);
    // rm refuses a directory without `recursive`, even as root.
    const directory = join(root, 'not-a-file');
    mkdirSync(join(directory, 'child'), { recursive: true });

    const error = await new Promise<unknown>((done) =>
      storage._removeFile({} as never, { path: directory } as Express.Multer.File, done),
    );

    expect(error).toMatchObject({ code: 'ERR_FS_EISDIR' });
    expect(existsSync(directory)).toBe(true);
  });
});
