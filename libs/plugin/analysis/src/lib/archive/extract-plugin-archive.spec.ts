import {
  PLUGIN_ARCHIVE_MAX_ENTRIES,
  PLUGIN_ARCHIVE_MAX_EXTRACTED_BYTES,
  PLUGIN_ARCHIVE_MAX_PATH_BYTES,
  PLUGIN_ARCHIVE_MAX_SEGMENT_BYTES,
} from '@boardgamesempire/plugin-manifest';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { PluginTarballEntry } from '../testing/plugin-tarball.js';
import { buildPluginTarball } from '../testing/plugin-tarball.js';
import { PluginArchiveRefusedError } from './archive.errors.js';
import {
  boundedDecompressedLimit,
  extractPluginArchive,
  PLUGIN_ARCHIVE_MAX_DECOMPRESSED_BYTES,
} from './extract-plugin-archive.js';

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual('node:fs/promises');
  return { ...actual, mkdir: jest.fn(actual.mkdir) };
});

jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs');
  return { ...actual, createWriteStream: jest.fn(actual.createWriteStream) };
});

/** Rewrites bytes in the first tar header, fixes its checksum and re-gzips. */
const withHeaderBytes = (tarball: Buffer, patch: Record<number, number>): Buffer => {
  const tar = Buffer.from(gunzipSync(tarball));
  for (const [offset, value] of Object.entries(patch)) {
    tar[Number(offset)] = value;
  }

  tar.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < 512; i += 1) {
    sum += tar[i];
  }

  tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return gzipSync(tar);
};

const VALID: PluginTarballEntry[] = [
  { name: 'package/manifest.json', content: JSON.stringify({ slug: 'demo-sink' }) },
  { name: 'package/package.json', content: '{}' },
];

describe('extractPluginArchive (#1094)', () => {
  let dir: string;
  let archivePath: string;
  let intoDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bge-extract-'));
    archivePath = join(dir, 'a.tgz');
    intoDir = join(dir, 'out');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = async (entries: PluginTarballEntry[]) => writeFile(archivePath, await buildPluginTarball(entries));

  const refusal = async (): Promise<PluginArchiveRefusedError> => {
    const err = await extractPluginArchive(archivePath, intoDir).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PluginArchiveRefusedError);
    return err as PluginArchiveRefusedError;
  };

  const exists = async (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    );

  it('extracts a valid archive, stripping its top-level directory (#1094)', async () => {
    await write([{ name: 'package/', type: 'directory' }, ...VALID, { name: 'package/dist/index.js', content: 'x' }]);

    const result = await extractPluginArchive(archivePath, intoDir);

    expect(result).toEqual({
      entryCount: 4,
      extractedBytes: 'x'.length + 2 + JSON.stringify({ slug: 'demo-sink' }).length,
    });
    expect(await readFile(join(intoDir, 'manifest.json'), 'utf8')).toContain('demo-sink');
    expect(await readFile(join(intoDir, 'package.json'), 'utf8')).toBe('{}');
    expect(await readFile(join(intoDir, 'dist', 'index.js'), 'utf8')).toBe('x');
    // An operator's stricter umask wins, so assert a ceiling and the owner bits.
    const dirMode = (await stat(join(intoDir, 'dist'))).mode & 0o777;
    const fileMode = (await stat(join(intoDir, 'package.json'))).mode & 0o777;
    expect(dirMode & ~0o755).toBe(0);
    expect(dirMode & 0o700).toBe(0o700);
    expect(fileMode & ~0o644).toBe(0);
    expect(fileMode & 0o600).toBe(0o600);
    expect(await exists(join(intoDir, 'package'))).toBe(false);
  });

  it('creates nothing for the top-level directory entry (#1094)', async () => {
    await write([{ name: 'package/', type: 'directory' }, ...VALID]);

    await extractPluginArchive(archivePath, intoDir);

    expect((await readdir(intoDir)).sort()).toEqual(['manifest.json', 'package.json']);
  });

  it.each([
    ['symlink', { name: 'package/link', type: 'symlink', linkname: '/etc/passwd' }, 'entry-type'],
    ['link', { name: 'package/link', type: 'link', linkname: 'package/manifest.json' }, 'entry-type'],
    ['../ path', { name: 'package/../escape.js', content: 'x' }, 'unsafe-path'],
    ['nested ../ path', { name: 'package/a/../../escape.js', content: 'x' }, 'unsafe-path'],
    ['absolute path', { name: '/etc/escape.js', content: 'x' }, 'unsafe-path'],
    ['second top-level directory', { name: 'other/x.js', content: 'x' }, 'top-level'],
  ] as const)('refuses a %s entry and leaves no files (#1094)', async (_label, bad, rule) => {
    // Valid entries come first, so the refusal strikes after files exist.
    await write([...VALID, { name: 'package/dist/ok.js', content: 'ok' }, bad]);

    const err = await refusal();

    expect(err.rule).toBe(rule);
    expect(err.name).toBe('PluginArchiveRefusedError');
    expect(await exists(intoDir)).toBe(false);
    expect(await exists(join(dir, 'escape.js'))).toBe(false);
  });

  it('refuses a pax path that escapes the tree (#1094)', async () => {
    await write([{ name: 'package/ok.js', content: 'x', pax: { path: '../escape.js' } }, ...VALID]);

    const err = await refusal();

    expect(err.rule).toBe('unsafe-path');
    expect(await exists(join(dir, 'escape.js'))).toBe(false);
    expect(await exists(intoDir)).toBe(false);
  });

  it('refuses a long name whose ../ lies past the header field, through a pax record (#1094)', async () => {
    const long = `package/${'a/'.repeat(80)}../../../../x.js`;
    await write([{ name: 'package/short.js', content: 'x', pax: { path: long } }]);

    expect((await refusal()).rule).toBe('unsafe-path');
  });

  it('refuses an archive that is not gzip (#1094)', async () => {
    await writeFile(archivePath, 'this is not a gzip file at all');

    expect((await refusal()).rule).toBe('not-gzip');
    expect(await exists(intoDir)).toBe(false);
  });

  it('refuses an empty file as not gzip (#1094)', async () => {
    await writeFile(archivePath, '');

    expect((await refusal()).rule).toBe('not-gzip');
  });

  it('refuses a truncated archive as corrupt and leaves no files (#1094)', async () => {
    const bytes = await buildPluginTarball([
      ...VALID,
      {
        name: 'package/big.bin',
        content: Array.from({ length: 4000 }, (_, i) => `line ${i} ${Math.random()}`).join('\n'),
      },
    ]);
    await writeFile(archivePath, bytes.subarray(0, Math.floor(bytes.length / 2)));

    expect((await refusal()).rule).toBe('corrupt');
    expect(await exists(intoDir)).toBe(false);
  });

  it('refuses a gzip stream that holds no tar as corrupt (#1094)', async () => {
    const { gzipSync } = await import('node:zlib');
    await writeFile(archivePath, gzipSync(Buffer.from('not a tar '.repeat(200))));

    expect((await refusal()).rule).toBe('corrupt');
  });

  it('refuses a missing required file at the end, leaving no files (#1094)', async () => {
    await write([{ name: 'package/manifest.json', content: '{}' }]);

    const err = await refusal();

    expect(err.rule).toBe('required-file');
    expect(err.entry).toBe('package.json');
    expect(await exists(intoDir)).toBe(false);
  });

  it('refuses a duplicate file name as corrupt and leaves nothing behind (#1094)', async () => {
    await write([...VALID, { name: 'package/manifest.json', content: 'second' }]);

    const err = await refusal();

    expect(err.rule).toBe('corrupt');
    expect(err.entry).toBe('package/manifest.json');
    expect(await exists(intoDir)).toBe(false);
  });

  it('refuses a file and a directory at the same path as corrupt (#1094)', async () => {
    await write([...VALID, { name: 'package/dist', content: 'file' }, { name: 'package/dist/x.js', content: 'x' }]);

    expect((await refusal()).rule).toBe('corrupt');
    expect(await exists(intoDir)).toBe(false);
  });

  it('refuses a directory entry over an existing file as corrupt (#1094)', async () => {
    await write([...VALID, { name: 'package/dist', content: 'file' }, { name: 'package/dist/', type: 'directory' }]);

    expect((await refusal()).rule).toBe('corrupt');
  });

  it('refuses a collision only the disk reports, such as two names a case-insensitive volume folds together, as corrupt (#1094)', async () => {
    // The checker refuses every collision it can see in the names; this is
    // the backstop behind it.
    await write([...VALID, { name: 'package/A.js', content: 'x' }]);
    (fs.createWriteStream as unknown as jest.Mock)
      .mockImplementationOnce(jest.requireActual('node:fs').createWriteStream)
      .mockImplementationOnce(jest.requireActual('node:fs').createWriteStream)
      .mockImplementationOnce(
        () =>
          new Writable({
            write(_chunk, _encoding, callback) {
              callback(Object.assign(new Error('file already exists'), { code: 'EEXIST', syscall: 'open' }));
            },
          }),
      );

    const err = await refusal();

    expect(err.rule).toBe('corrupt');
    expect(err.entry).toBe('package/A.js');
    expect(await exists(intoDir)).toBe(false);
  });

  it('lets a failure of mkdir on intoDir propagate as it is (#1094)', async () => {
    await write(VALID);
    // intoDir's parent is a file, so mkdir fails with ENOTDIR before any entry is read.
    await writeFile(join(dir, 'blocker'), '');

    const err = await extractPluginArchive(archivePath, join(dir, 'blocker', 'out')).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).not.toBeInstanceOf(PluginArchiveRefusedError);
    expect(err).toMatchObject({ code: 'ENOTDIR', syscall: 'mkdir' });
  });

  it('refuses an intoDir that already exists with EEXIST, and leaves what is in it (#1094)', async () => {
    // The cleanup after a refusal removes intoDir whole, so the extractor only
    // writes into a directory it made itself.
    await write([...VALID, { name: 'other/x.js', content: 'x' }]);
    await mkdir(intoDir);
    await writeFile(join(intoDir, 'keep'), 'keep');

    const err = await extractPluginArchive(archivePath, intoDir).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toMatchObject({ code: 'EEXIST', syscall: 'mkdir' });
    expect(await readFile(join(intoDir, 'keep'), 'utf8')).toBe('keep');
  });

  it('lets a disk-full error while writing an entry propagate unchanged and cleans up (#1094)', async () => {
    await write(VALID);
    (fs.createWriteStream as unknown as jest.Mock).mockImplementationOnce(
      () =>
        new Writable({
          write(_chunk, _encoding, callback) {
            callback(Object.assign(new Error('no space left'), { code: 'ENOSPC', syscall: 'write' }));
          },
        }),
    );

    const err = await extractPluginArchive(archivePath, intoDir).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).not.toBeInstanceOf(PluginArchiveRefusedError);
    expect(err).toMatchObject({ code: 'ENOSPC', syscall: 'write' });
    expect(await exists(intoDir)).toBe(false);
  });

  it('refuses a name over the caps as unsafe-path, refused by the archive rules before extraction (#1166)', async () => {
    await write([...VALID, { name: `package/${'n'.repeat(300)}`, content: 'x' }]);

    const err = await refusal();

    expect(err.rule).toBe('unsafe-path');
    expect(await exists(intoDir)).toBe(false);
  });

  // The extractor's own ENAMETOOLONG mapping stays for a name the disk refuses
  // below the caps (a filesystem with a shorter limit, say).
  it('refuses a name the disk cannot hold below the caps as unsafe-path (#1166)', async () => {
    await write(VALID);
    (fs.createWriteStream as unknown as jest.Mock).mockImplementationOnce(
      () =>
        new Writable({
          write(_chunk, _encoding, callback) {
            callback(Object.assign(new Error('name too long'), { code: 'ENAMETOOLONG', syscall: 'open' }));
          },
        }),
    );

    const err = await refusal();

    expect(err.rule).toBe('unsafe-path');
    expect(err.entry).toBe('package/manifest.json');
    expect(await exists(intoDir)).toBe(false);
  });

  it('refuses a header whose size field is not a plain number as corrupt, without hanging (#1094)', async () => {
    const tarball = await buildPluginTarball([
      { name: 'package/manifest.json', content: 'x'.repeat(1000) },
      { name: 'package/package.json', content: '{}' },
    ]);
    // A first size byte in 0x81-0xFE makes tar-stream report a null size.
    await writeFile(archivePath, withHeaderBytes(tarball, { 124: 0x81 }));

    const err = await refusal();

    expect(err.rule).toBe('corrupt');
    expect(err.entry).toBe('package/manifest.json');
    expect(await exists(intoDir)).toBe(false);
  }, 10_000);

  it.each([
    ['S', 'GNU sparse'],
    ['Z', 'an unknown type'],
  ])(
    'refuses typeflag %s (%s) as entry-type, never as a regular file (#1094)',
    async (flag) => {
      const tarball = await buildPluginTarball([
        { name: 'package/manifest.json', content: 'x'.repeat(1000) },
        ...VALID,
      ]);
      await writeFile(archivePath, withHeaderBytes(tarball, { 156: flag.charCodeAt(0) }));

      expect((await refusal()).rule).toBe('entry-type');
      expect(await exists(intoDir)).toBe(false);
    },
    10_000,
  );

  it('refuses an archive that decompresses past the bound as extracted-size (#1094)', async () => {
    await write([...VALID, { name: 'package/pad.bin', content: 'x'.repeat(100_000) }]);

    const err = await extractPluginArchive(archivePath, intoDir, { maxDecompressedBytes: 50_000 }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toMatchObject({ rule: 'extracted-size' });
    expect(await exists(intoDir)).toBe(false);
  });

  it('refuses a large first entry past a small bound promptly, not hanging mid-write (#1094)', async () => {
    const noise = Array.from({ length: 6000 }, (_, i) => `${i}:${Math.random()}`).join('\n');
    await write([{ name: 'package/manifest.json', content: noise }, ...VALID]);

    const err = await extractPluginArchive(archivePath, intoDir, { maxDecompressedBytes: 20_000 }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toMatchObject({ rule: 'extracted-size' });
    expect(await exists(intoDir)).toBe(false);
  }, 10_000);

  it('refuses a truncated archive as corrupt even when mkdir is slow (#1094)', async () => {
    const noise = Array.from({ length: 6000 }, (_, i) => `${i}:${Math.random()}`).join('\n');
    const bytes = await buildPluginTarball([{ name: 'package/dist/big.js', content: noise }, ...VALID]);
    await writeFile(archivePath, bytes.subarray(0, Math.floor(bytes.length / 2)));
    const realMkdir = jest.requireActual('node:fs/promises').mkdir;
    (fsPromises.mkdir as unknown as jest.Mock).mockImplementation(async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return realMkdir(...args);
    });

    try {
      expect((await refusal()).rule).toBe('corrupt');
    } finally {
      (fsPromises.mkdir as unknown as jest.Mock).mockImplementation(realMkdir);
    }

    expect(await exists(intoDir)).toBe(false);
  }, 10_000);

  it('extracts an archive with no end-of-archive blocks even when mkdir is slow (#1094)', async () => {
    const tar = Buffer.from(gunzipSync(await buildPluginTarball(VALID)));
    // tar-stream's pack ends with two 512-byte zero blocks; drop them.
    expect(tar.subarray(tar.length - 1024).every((byte) => byte === 0)).toBe(true);
    await writeFile(archivePath, gzipSync(tar.subarray(0, tar.length - 1024)));
    const realMkdir = jest.requireActual('node:fs/promises').mkdir;
    (fsPromises.mkdir as unknown as jest.Mock).mockImplementation(async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return realMkdir(...args);
    });

    try {
      await expect(extractPluginArchive(archivePath, intoDir)).resolves.toMatchObject({ entryCount: 2 });
    } finally {
      (fsPromises.mkdir as unknown as jest.Mock).mockImplementation(realMkdir);
    }

    expect(await readFile(join(intoDir, 'package.json'), 'utf8')).toBe('{}');
  }, 10_000);

  // An archive that only passes a loosened bound would need over 512 MiB, so
  // the clamp is asserted directly.
  it.each([
    ['Infinity', Infinity],
    ['NaN', NaN],
    ['a negative value', -5],
    ['zero', 0],
    ['twice the production bound', PLUGIN_ARCHIVE_MAX_DECOMPRESSED_BYTES * 2],
    ['undefined', undefined],
  ])('never lets %s raise the decompression bound above the production one (#1094)', (_label, bound) => {
    expect(boundedDecompressedLimit(bound)).toBe(PLUGIN_ARCHIVE_MAX_DECOMPRESSED_BYTES);
  });

  // An artifact that passes every archive rule must fit the bound, or the
  // server refuses as extracted-size one that `bge-plugin build` wrote. The
  // longest name the rules allow needs pax records, so its framing is more
  // than a header block and padding (#1166).
  it('allows each entry the tar framing of the longest name the archive rules allow (#1166)', async () => {
    const top = 't'.repeat(PLUGIN_ARCHIVE_MAX_SEGMENT_BYTES);
    const segment = (char: string) => char.repeat(PLUGIN_ARCHIVE_MAX_SEGMENT_BYTES);
    const path = [segment('a'), segment('b'), segment('c'), 'd'.repeat(PLUGIN_ARCHIVE_MAX_SEGMENT_BYTES - 1), 'e'].join(
      '/',
    );
    expect(Buffer.byteLength(path)).toBe(PLUGIN_ARCHIVE_MAX_PATH_BYTES);

    const tar = gunzipSync(await buildPluginTarball([{ name: `./${top}/${path}`, content: 'x' }]));
    const endBlocks = 1024;
    const framing = tar.length - endBlocks - 'x'.length;
    const allowance =
      (PLUGIN_ARCHIVE_MAX_DECOMPRESSED_BYTES - PLUGIN_ARCHIVE_MAX_EXTRACTED_BYTES - 1024 * 1024) /
      PLUGIN_ARCHIVE_MAX_ENTRIES;

    expect(framing).toBeGreaterThan(2048);
    expect(framing).toBeLessThanOrEqual(allowance);
  });

  it('lets the hook tighten the decompression bound (#1094)', () => {
    expect(boundedDecompressedLimit(1234)).toBe(1234);
  });

  it('quotes and truncates an entry name in the message but keeps it raw on the error (#1094)', () => {
    const raw = `package/a\nforged line${'z'.repeat(400)}`;

    const err = new PluginArchiveRefusedError('unsafe-path', raw);

    expect(err.entry).toBe(raw);
    expect(err.message).not.toContain('\n');
    expect(err.message.length).toBeLessThan(300);
  });

  it('refuses an archive of more entries than the cap, mid-stream (#1094)', async () => {
    const entries: PluginTarballEntry[] = [
      ...VALID,
      ...Array.from({ length: PLUGIN_ARCHIVE_MAX_ENTRIES - 1 }, (_, i) => ({ name: `package/d/${i}`, content: '' })),
    ];
    await write(entries);

    expect((await refusal()).rule).toBe('entry-count');
    expect(await exists(intoDir)).toBe(false);
  }, 120_000);
});
